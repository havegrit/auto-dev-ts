import { describe, expect, it, vi } from 'vitest';
import {
  commitIssueWorktree,
  issueWorktreeCheckpoint,
  prepareIssueWorktree,
  pushIssueWorktree,
  type IssueGitDependencies,
  type IssueWorktreeContext,
} from './issue-worktree.js';

const sourceDir = '/repo';
const worktreeDir = '/tmp/auto-dev-worktrees/12345678-0000-0000-0000-000000000000';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function context(): IssueWorktreeContext {
  return {
    sourceDir,
    worktreeDir,
    remote: 'origin',
    branch: 'autodev/issue/ad-42-12345678',
    baseBranch: 'main',
    baseSha,
    workflowRunId: '12345678-0000-0000-0000-000000000000',
    issueKey: 'AD-42',
  };
}

describe('issue Git worktrees', () => {
  it('creates an isolated branch from the configured remote default branch', async () => {
    const calls: string[][] = [];
    const dependencies: IssueGitDependencies = {
      worktreeRoot: '/tmp/auto-dev-worktrees',
      mkdir: vi.fn(async () => {}),
      run: vi.fn(async (_command, args) => {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return sourceDir;
        if (args[0] === 'ls-remote') return 'ref: refs/heads/main\tHEAD';
        if (args[0] === 'rev-parse') return baseSha;
        return '';
      }),
    };

    const prepared = await prepareIssueWorktree(sourceDir, '12345678-0000-0000-0000-000000000000', 'AD-42', undefined, dependencies);

    expect(prepared).toMatchObject({
      worktreeDir,
      branch: 'autodev/issue/ad-42-12345678',
      baseBranch: 'main',
      baseSha,
      remote: 'origin',
    });
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'autodev/issue/ad-42-12345678', worktreeDir, baseSha]);
  });

  it('records HEAD and changed paths as a branch checkpoint', async () => {
    const dependencies: IssueGitDependencies = {
      worktreeRoot: '/tmp',
      mkdir: vi.fn(async () => {}),
      run: vi.fn(async (_command, args) => args[0] === 'rev-parse'
        ? headSha
        : ' M src/fix.ts\n?? tests/fix.test.ts'),
    };

    await expect(issueWorktreeCheckpoint(context(), dependencies)).resolves.toEqual({
      headSha,
      changedPaths: ['src/fix.ts', 'tests/fix.test.ts'],
    });
  });

  it('records the current commit for an otherwise clean branch', async () => {
    const dependencies: IssueGitDependencies = {
      worktreeRoot: '/tmp',
      mkdir: vi.fn(async () => {}),
      run: vi.fn(async (_command, args) => args[0] === 'status' ? '' : baseSha),
    };
    await expect(commitIssueWorktree(context(), 'success', 'no changes', dependencies)).resolves.toBe(baseSha);
  });

  it('refuses to overwrite a remote branch that moved to a different commit', async () => {
    const differentSha = 'c'.repeat(40);
    const dependencies: IssueGitDependencies = {
      worktreeRoot: '/tmp',
      mkdir: vi.fn(async () => {}),
      run: vi.fn(async () => `${differentSha}\trefs/heads/${context().branch}`),
    };
    await expect(pushIssueWorktree(context(), headSha, dependencies)).rejects.toThrow(/force push is disabled/);
  });
});
