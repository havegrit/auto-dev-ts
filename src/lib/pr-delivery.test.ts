import { describe, expect, it, vi } from 'vitest';
import {
  completePullRequestDelivery,
  preparePullRequestWorktree,
  type PullRequestDeliveryContext,
} from './pr-delivery.js';

const config = { mode: 'pull-request' as const, baseBranch: 'main' };
const env = {
  AUTO_DEV_PUBLIC_BASE_URL: 'https://dashboard.example.test/',
  AUTO_DEV_PUBLIC_ACCESS_CONTROL: 'authenticated',
};
const baseSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);

function context(): PullRequestDeliveryContext {
  return {
    workflowRunId: 'run-12345678',
    dashboardRunId: 'run-latest',
    sourceDir: '/project',
    worktreeDir: '/tmp/worktrees/run-12345678',
    remote: 'origin',
    repository: 'org/project',
    branch: 'autodev/run-123',
    baseBranch: 'main',
    baseSha,
    publicBaseUrl: 'https://dashboard.example.test',
    accessControl: 'authenticated',
  };
}

describe('preparePullRequestWorktree', () => {
  it('checks GitHub, HTTPS evidence access, base SHA, then creates a run-only worktree', () => {
    const commands: string[] = [];
    const workflowRunId = '12345678-1234-1234-1234-123456789abc';
    const prepared = preparePullRequestWorktree('/project', workflowRunId, config, env, {
      run: (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'remote') return 'git@github.com:org/project.git';
        if (command === 'gh' && args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/project', defaultBranchRef: { name: 'main' } });
        if (args[0] === 'rev-parse') return baseSha;
        return '';
      },
      exists: () => false,
      mkdir: vi.fn(),
      worktreeRoot: '/tmp/worktrees',
    });

    expect(prepared).toMatchObject({
      repository: 'org/project', baseBranch: 'main', baseSha,
      branch: 'autodev/12345678', worktreeDir: `/tmp/worktrees/${workflowRunId}`,
      publicBaseUrl: 'https://dashboard.example.test', accessControl: 'authenticated',
    });
    expect(commands).toContain(`git worktree add -b autodev/12345678 /tmp/worktrees/${workflowRunId} ${baseSha}`);
    expect(commands.indexOf('gh auth status')).toBeLessThan(commands.findIndex(command => command.startsWith('git worktree add')));
  });

  it('requires an HTTPS URL and an explicit external access-control assertion before running git or gh', () => {
    const run = vi.fn(() => '');
    const deps = { run, exists: () => false, mkdir: vi.fn(), worktreeRoot: '/tmp/worktrees' };
    expect(() => preparePullRequestWorktree('/project', 'run-12345678', config, {
      AUTO_DEV_PUBLIC_BASE_URL: 'http://dashboard.example.test',
      AUTO_DEV_PUBLIC_ACCESS_CONTROL: 'authenticated',
    }, deps)).toThrow(/must be HTTPS/);
    expect(() => preparePullRequestWorktree('/project', 'run-12345678', config, {
      AUTO_DEV_PUBLIC_BASE_URL: env.AUTO_DEV_PUBLIC_BASE_URL,
    }, deps)).toThrow(/AUTO_DEV_PUBLIC_ACCESS_CONTROL/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('completePullRequestDelivery', () => {
  it('commits, pushes without force, creates and verifies a PR with a safe deep link', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    let headReads = 0;
    const run = (command: 'git' | 'gh', args: string[]) => {
      commands.push({ command, args });
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return headReads++ === 0 ? baseSha : commitSha;
      if (command === 'git' && args[0] === 'status') return ' M src/feature.ts';
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD^') return baseSha;
      if (command === 'git' && args[0] === 'ls-remote') return '';
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://github.com/org/project/pull/7';
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
        number: 7, url: 'https://github.com/org/project/pull/7', headRefOid: commitSha,
        headRefName: 'autodev/run-123', baseRefName: 'main',
      });
      if (command === 'git' && args[0] === 'log') return 'feat: run\n\nAuto-Dev-Run: run-12345678';
      return '';
    };
    const stages: string[] = [];

    const result = await completePullRequestDelivery(context(), {
      requestSummary: 'Add feature token=shhh',
      verifyConfigured: true,
      verifySummary: 'Deterministic verify: PASS',
      reviewSummary: 'Review verdict: SHIP',
      testRegressionAllowed: true,
    }, (stage) => { stages.push(stage); }, { run });

    expect(result).toMatchObject({ status: 'DELIVERED', commitSha, prNumber: 7, prUrl: 'https://github.com/org/project/pull/7' });
    expect(stages).toEqual(['commit', 'commit', 'push', 'pull-request', 'pull-request']);
    const push = commands.find(({ command, args }) => command === 'git' && args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', 'HEAD:refs/heads/autodev/run-123']);
    expect(push?.args).not.toContain('--force');
    const create = commands.find(({ command, args }) => command === 'gh' && args[1] === 'create');
    const body = create?.args[create.args.indexOf('--body') + 1] ?? '';
    expect(body).toContain('https://dashboard.example.test/?run=run-latest');
    expect(body).toContain('token=[redacted]');
    expect(body).not.toContain('shhh');
    expect(body).toContain(commitSha);
    expect(body).toContain(baseSha);
    expect(body).toContain('Test regression override: ENABLED');
  });

  it('reuses an open PR only when its head matches the verified commit', async () => {
    let headReads = 0;
    const run = (command: 'git' | 'gh', args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return headReads++ === 0 ? baseSha : commitSha;
      if (command === 'git' && args[0] === 'status') return ' M src/feature.ts';
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD^') return baseSha;
      if (command === 'git' && args[0] === 'ls-remote') return commitSha;
      if (command === 'gh' && args[1] === 'list') return JSON.stringify([{
        number: 7, url: 'https://github.com/org/project/pull/7', headRefOid: commitSha,
        headRefName: 'autodev/run-123', baseRefName: 'main',
      }]);
      return '';
    };
    const call = vi.fn(run);
    const result = await completePullRequestDelivery(context(), {
      requestSummary: 'feature', verifySummary: 'PASS', reviewSummary: 'SHIP',
    }, undefined, { run: call });

    expect(result.prUrl).toBe('https://github.com/org/project/pull/7');
    expect(call).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['create']), expect.anything());
  });

  it('stops rather than force-updating an unexpected remote branch', async () => {
    const run = vi.fn((command: 'git' | 'gh', args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return baseSha;
      if (args[0] === 'status') return ' M src/feature.ts';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD^') return baseSha;
      if (args[0] === 'ls-remote') return 'c'.repeat(40) + '\trefs/heads/autodev/run-123';
      return '';
    });

    await expect(completePullRequestDelivery(context(), {
      requestSummary: 'feature', verifySummary: 'PASS', reviewSummary: 'SHIP',
    }, undefined, { run })).rejects.toThrow(/Force push is disabled/);
    expect(run.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });
});
