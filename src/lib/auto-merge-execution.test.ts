import { describe, expect, it, vi } from 'vitest';
import { requestQualifiedAutoMerge, type AutoMergeExecutionDependencies, type AutoMergeExecutionInput } from './auto-merge-execution.js';
import type { AutoMergeDryRunResult } from './auto-merge.js';
import type { PullRequestDeliveryContext } from './pr-delivery.js';

const eligibleDryRun: AutoMergeDryRunResult = {
  mode: 'dry-run', eligible: true, category: 'docs', policyFingerprint: 'policy-a',
  headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40),
  eval: { passedCount: 20, distinctCaseCount: 10, requiredCount: 20, requiredDistinctCases: 10, qualifies: true },
  live: { passedCount: 10, requiredCount: 10, qualifies: true },
  reasons: [], checkedAt: '2026-10-16T00:00:00.000Z',
};

function context(): PullRequestDeliveryContext {
  return {
    workflowRunId: 'run-12345678', sourceDir: '/repo', worktreeDir: '/repo/worktree',
    remote: 'origin', repository: 'org/project', branch: 'autodev/12345678', baseBranch: 'main',
    baseSha: 'a'.repeat(40), publicBaseUrl: 'https://dashboard.example', accessControl: 'authenticated',
    state: { status: 'DELIVERED', prNumber: 42, commitSha: 'b'.repeat(40) },
  };
}

function input(overrides: Partial<AutoMergeExecutionInput> = {}): AutoMergeExecutionInput {
  return {
    context: context(),
    projectConfig: { version: 1, delivery: { mode: 'pull-request', autoMerge: { enabled: true, requestMerge: true } } },
    configFingerprintAtStart: 'config-a',
    startingPolicyFingerprint: 'policy-a',
    models: { scaffold: 'model-a' },
    evidence: { deterministicConfigured: true, deterministicPassed: true, reviewPassed: true, evidenceStored: true },
    autoMergeEnabledAtStart: true,
    autoMergeRequestEnabledAtStart: true,
    projectConfigUnchanged: true,
    dryRun: eligibleDryRun,
    ...overrides,
  };
}

function dependencies(overrides: {
  env?: NodeJS.ProcessEnv;
    enabled?: boolean;
  dryRun?: AutoMergeDryRunResult;
  view?: Record<string, unknown>;
  claim?: { state: 'claimed' | 'requested' | 'failed' };
  mergeError?: Error;
  claimSucceeds?: boolean;
} = {}) {
  const records: Array<Record<string, unknown>> = [];
  const gh = vi.fn((args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
      state: 'OPEN', headRefOid: 'b'.repeat(40), autoMergeRequest: null,
      ...(overrides.view ?? {}),
    });
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (overrides.mergeError) throw overrides.mergeError;
      return 'Auto-merge enabled';
    }
    throw new Error(`Unexpected GitHub command: ${args.join(' ')}`);
  });
  const deps: AutoMergeExecutionDependencies = {
    env: overrides.env ?? {
      AUTO_DEV_AUTO_MERGE_ENABLED: 'true',
      AUTO_DEV_AUTO_MERGE_REPOSITORIES: 'org/project',
    },
    enabled: () => overrides.enabled !== false,
    gh,
    evaluate: vi.fn(() => overrides.dryRun ?? eligibleDryRun),
    getClaim: vi.fn(() => overrides.claim ? {
      workflowRunId: 'prior-run', state: overrides.claim.state,
      createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
    } : undefined),
    claim: vi.fn(() => overrides.claimSucceeds !== false),
    finishClaim: vi.fn(),
    record: vi.fn((record: any) => { records.push(record); }),
    now: () => new Date('2026-10-16T00:00:00.000Z'),
  };
  return { deps, gh, records };
}

describe('requestQualifiedAutoMerge', () => {
  it('records an intent and requests GitHub auto-merge only after fresh qualification', () => {
    const { deps, gh, records } = dependencies();
    const result = requestQualifiedAutoMerge(input(), deps);

    expect(result).toMatchObject({ status: 'requested', reason: expect.stringContaining('branch protection remains in force') });
    expect(deps.evaluate).toHaveBeenCalledOnce();
    expect(gh).toHaveBeenCalledWith(['pr', 'view', '42', '--repo', 'org/project', '--json', 'state,headRefOid,autoMergeRequest'], '/repo/worktree');
    expect(gh).toHaveBeenCalledWith([
      'pr', 'merge', '42', '--repo', 'org/project', '--match-head-commit', 'b'.repeat(40), '--auto',
    ], '/repo/worktree');
    expect(records.map(record => record.status)).toEqual(['pending', 'requested']);
    expect(deps.claim).toHaveBeenCalledWith(expect.objectContaining({ repository: 'org/project', prNumber: 42, headSha: 'b'.repeat(40) }));
    expect(deps.finishClaim).toHaveBeenCalledWith('org/project', 42, 'b'.repeat(40), 'requested');
  });

  it('fails closed unless project opt-in, the global kill switch, and the repository allowlist all agree', () => {
    const cases = [
      { config: { enabled: true, requestMerge: false }, start: true, env: { AUTO_DEV_AUTO_MERGE_ENABLED: 'true', AUTO_DEV_AUTO_MERGE_REPOSITORIES: 'org/project' } },
      { config: { enabled: true, requestMerge: true }, start: true, env: { AUTO_DEV_AUTO_MERGE_ENABLED: 'false', AUTO_DEV_AUTO_MERGE_REPOSITORIES: 'org/project' } },
      { config: { enabled: true, requestMerge: true }, start: true, env: { AUTO_DEV_AUTO_MERGE_ENABLED: 'true', AUTO_DEV_AUTO_MERGE_REPOSITORIES: 'org/other' } },
    ];
    for (const scenario of cases) {
      const { deps, gh } = dependencies({ env: scenario.env });
      const result = requestQualifiedAutoMerge(input({
        projectConfig: { version: 1, delivery: { mode: 'pull-request', autoMerge: scenario.config } },
        autoMergeRequestEnabledAtStart: scenario.start,
      }), deps);
      expect(result.status).toBe('blocked');
      expect(gh).not.toHaveBeenCalled();
      expect(deps.evaluate).not.toHaveBeenCalled();
    }
    const globalDisabled = dependencies({ enabled: false });
    expect(requestQualifiedAutoMerge(input(), globalDisabled.deps)).toMatchObject({ status: 'blocked', reason: 'Global auto-merge kill switch is off.' });
    expect(globalDisabled.gh).not.toHaveBeenCalled();
  });

  it('does not request when the dry-run or fresh recheck is no longer eligible', () => {
    const initialDenied = dependencies();
    expect(requestQualifiedAutoMerge(input({ dryRun: { ...eligibleDryRun, eligible: false } }), initialDenied.deps).status).toBe('blocked');
    expect(initialDenied.gh).not.toHaveBeenCalled();

    const recheckDenied = dependencies({ dryRun: { ...eligibleDryRun, eligible: false } });
    const result = requestQualifiedAutoMerge(input(), recheckDenied.deps);
    expect(result.status).toBe('blocked');
    expect(recheckDenied.gh).not.toHaveBeenCalled();
  });

  it('handles an existing GitHub request or prior claim without duplicating the command', () => {
    const alreadyOnGitHub = dependencies({ view: { autoMergeRequest: { enabledAt: '2026-10-15T00:00:00Z' } } });
    expect(requestQualifiedAutoMerge(input(), alreadyOnGitHub.deps).status).toBe('already-requested');
    expect(alreadyOnGitHub.gh.mock.calls.some(([args]) => args[1] === 'merge')).toBe(false);

    const priorRequest = dependencies({ claim: { state: 'requested' } });
    expect(requestQualifiedAutoMerge(input(), priorRequest.deps).status).toBe('already-requested');
    expect(priorRequest.gh).not.toHaveBeenCalled();

    const unresolved = dependencies({ claim: { state: 'claimed' } });
    expect(requestQualifiedAutoMerge(input(), unresolved.deps).status).toBe('blocked');
    expect(unresolved.gh).not.toHaveBeenCalled();
  });

  it('refuses a changed head immediately before requesting auto-merge', () => {
    const { deps, gh } = dependencies({ view: { headRefOid: 'c'.repeat(40) } });
    const result = requestQualifiedAutoMerge(input(), deps);
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/head changed/);
    expect(gh.mock.calls.some(([args]) => args[1] === 'merge')).toBe(false);
  });

  it('records a failed GitHub request and leaves the head claim fail-closed', () => {
    const { deps, gh, records } = dependencies({ mergeError: new Error('GitHub unavailable') });
    const result = requestQualifiedAutoMerge(input(), deps);
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('GitHub unavailable') });
    expect(records.map(record => record.status)).toEqual(['pending', 'failed']);
    expect(deps.finishClaim).toHaveBeenCalledWith('org/project', 42, 'b'.repeat(40), 'failed');
    expect(gh.mock.calls.some(([args]) => args[1] === 'merge')).toBe(true);
  });

  it('does not send the merge request if it cannot persist the intent record', () => {
    const { deps, gh } = dependencies();
    vi.mocked(deps.record).mockImplementationOnce(() => { throw new Error('database unavailable'); });
    const result = requestQualifiedAutoMerge(input(), deps);
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('no GitHub merge request was sent') });
    expect(gh.mock.calls.some(([args]) => args[1] === 'merge')).toBe(false);
  });
});
