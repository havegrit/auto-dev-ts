import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, getIssue, updateIssue, addComment, getIssueTracker, testAgent, runSpec, runVerifyStep, snapshotWorkspace, emitRunEvent, insertRun, updateRun, loadProjectConfig, tryAcquireIssueExecution, finishIssueExecution, prepareIssueWorktree, issueWorktreeCheckpoint, commitIssueWorktree, pushIssueWorktree, removePushedIssueWorktree, updateIssueExecution } = vi.hoisted(() => {
  const state = {
    issue: {
      key: 'AD-42', title: '잘못된 응답', description: '재현 조건', type: 'BUG',
      priority: 'HIGH', status: 'OPEN', updatedAt: '2026-10-16',
    } as any,
    provider: undefined as string | undefined,
  };
  const getIssue = vi.fn(async () => state.issue);
  const updateIssue = vi.fn(async (_key: string, _patch: { status?: string; linkedRunId?: string }) => {});
  const addComment = vi.fn(async () => {});
  const testAgent = vi.fn();
  const runSpec = vi.fn();
  const runVerifyStep = vi.fn();
  const snapshotWorkspace = vi.fn();
  const emitRunEvent = vi.fn();
  const insertRun = vi.fn();
  const updateRun = vi.fn();
  const loadProjectConfig = vi.fn(() => undefined);
  const tryAcquireIssueExecution = vi.fn(() => ({ acquired: true, execution: {} }));
  const finishIssueExecution = vi.fn();
  const prepareIssueWorktree = vi.fn(async (sourceDir: string, workflowRunId: string, issueKey: string) => ({
    sourceDir, workflowRunId, issueKey, worktreeDir: '/worktree/issue', remote: 'origin', branch: 'autodev/issue/ad-42-run', baseBranch: 'main', baseSha: 'base-sha',
  }));
  const issueWorktreeCheckpoint = vi.fn(async () => ({ headSha: 'checkpoint-sha', changedPaths: ['src/fix.ts'] }));
  const commitIssueWorktree = vi.fn(async () => 'commit-sha');
  const pushIssueWorktree = vi.fn(async () => {});
  const removePushedIssueWorktree = vi.fn(async () => {});
  const updateIssueExecution = vi.fn();
  return {
    state,
    getIssue,
    updateIssue,
    addComment,
    getIssueTracker: vi.fn(() => ({ provider: state.provider, getIssue, updateIssue, addComment })),
    testAgent,
    runSpec,
    runVerifyStep,
    snapshotWorkspace,
    emitRunEvent,
    insertRun,
    updateRun,
    loadProjectConfig,
    tryAcquireIssueExecution,
    finishIssueExecution,
    prepareIssueWorktree,
    issueWorktreeCheckpoint,
    commitIssueWorktree,
    pushIssueWorktree,
    removePushedIssueWorktree,
    updateIssueExecution,
  };
});

vi.mock('../integrations/issue-tracker/index.js', () => ({ getIssueTracker }));
vi.mock('../agents/test.js', () => ({ test: testAgent }));
vi.mock('../lib/project-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/project-config.js')>()),
  loadProjectConfig,
}));
vi.mock('../lib/role-boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/role-boundary.js')>()),
  snapshotWorkspace,
}));
vi.mock('../lib/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspace.js')>()),
  defaultWorkspaceDir: () => '/workspace/project',
}));
vi.mock('../lib/run-events.js', () => ({ emitRunEvent }));
vi.mock('../store/runs.js', () => ({ insertRun, updateRun }));
vi.mock('../store/issue-executions.js', () => ({
  tryAcquireIssueExecution,
  finishIssueExecution,
  heartbeatIssueExecution: vi.fn(() => true),
  listDueIssueDeliveries: vi.fn(() => []),
  listDueIssueStateUpdates: vi.fn(() => []),
  expireStaleIssueExecutions: vi.fn(() => []),
  updateIssueExecution,
}));
vi.mock('../lib/issue-worktree.js', () => ({
  prepareIssueWorktree,
  issueWorktreeCheckpoint,
  commitIssueWorktree,
  pushIssueWorktree,
  removePushedIssueWorktree,
  remoteIssueBranchSha: vi.fn(),
}));
vi.mock('./verify-gate.js', () => ({ runVerifyStep }));
vi.mock('./spec.js', () => ({
  runSpec,
  workflowOutput: (result: { verdict?: string }) => `verdict: ${result.verdict ?? 'UNKNOWN'}`,
  workflowRunStatus: (result: { verdict?: string }) => result.verdict === 'SHIP' ? 'DONE' : 'FAILED',
}));

import { isBugIssueType, parseReproCommand, processIssue } from './from-issue.js';

function runResult(overrides: Record<string, unknown> = {}) {
  return {
    workflowRunId: 'workflow-run',
    steps: {},
    totalDurationMs: 20,
    verdict: 'SHIP',
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(state.issue, {
    key: 'AD-42', title: '잘못된 응답', description: '재현 조건', type: 'BUG',
    priority: 'HIGH', status: 'OPEN', updatedAt: '2026-10-16',
  });
  state.provider = undefined;
  vi.clearAllMocks();
  getIssue.mockResolvedValue(state.issue);
  testAgent.mockResolvedValue({
    runId: 'repro-test-run',
    output: '재현 테스트 작성 완료\n[REPRO: npm test -- --run src/widget.test.ts]',
    status: 'DONE',
    durationMs: 12,
  });
  runVerifyStep.mockResolvedValue({
    runId: 'repro-command-run',
    passed: true,
    outcome: { exitCode: 1, timedOut: false, cancelled: false, durationMs: 7, outputTail: 'expected 1, received 0' },
  });
  runSpec.mockResolvedValue(runResult());
  snapshotWorkspace.mockResolvedValue(new Map());
  loadProjectConfig.mockReturnValue(undefined);
  tryAcquireIssueExecution.mockReturnValue({ acquired: true, execution: {} } as any);
  prepareIssueWorktree.mockImplementation(async (sourceDir, workflowRunId, issueKey) => ({
    sourceDir, workflowRunId, issueKey, worktreeDir: '/worktree/issue', remote: 'origin', branch: 'autodev/issue/ad-42-run', baseBranch: 'main', baseSha: 'base-sha',
  }));
  issueWorktreeCheckpoint.mockResolvedValue({ headSha: 'checkpoint-sha', changedPaths: ['src/fix.ts'] });
  commitIssueWorktree.mockResolvedValue('commit-sha');
  pushIssueWorktree.mockResolvedValue(undefined);
  removePushedIssueWorktree.mockResolvedValue(undefined);
});

describe('bug issue mode', () => {
  it('rejects PR delivery before reproduction agents or issue status changes', async () => {
    loadProjectConfig.mockReturnValue({ version: 1, delivery: { mode: 'pull-request' } } as any);

    await expect(processIssue('AD-42')).rejects.toThrow(/Issue-triggered workflows do not support PR delivery yet/);

    expect(testAgent).not.toHaveBeenCalled();
    expect(runSpec).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('matches only the BUG type, ignoring case and surrounding whitespace', () => {
    expect(isBugIssueType('bug')).toBe(true);
    expect(isBugIssueType(' BUG ')).toBe(true);
    expect(isBugIssueType('BUGFIX')).toBe(false);
    expect(isBugIssueType('TASK')).toBe(false);
  });

  it('parses the final REPRO marker and rejects an empty or oversized command', () => {
    expect(parseReproCommand('old\n[REPRO: npm test]\n[REPRO: ./gradlew test]')).toBe('./gradlew test');
    expect(parseReproCommand('[REPRO:   ]')).toBeUndefined();
    expect(parseReproCommand(`[REPRO: ${'x'.repeat(2_001)}]`)).toBeUndefined();
  });

  it('confirms the failing repro before marking the issue in progress, then passes the command into runSpec', async () => {
    const result = await processIssue('AD-42');
    const linkedRunId = updateIssue.mock.calls[0][1].linkedRunId;

    expect(result).toMatchObject({ issueKey: 'AD-42', verdict: 'SHIP', finalStatus: 'DONE' });
    expect(testAgent).toHaveBeenCalledWith(expect.stringContaining('프로덕션 코드는 수정하지 마라'), expect.objectContaining({
      cwd: '/workspace/project',
      workflowRunId: linkedRunId,
      triggerSource: 'issue',
    }));
    expect(runVerifyStep).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: '/workspace/project',
      expectedOutcome: 'fail',
      triggerDetail: 'AD-42:bug-reproduction-baseline',
      verify: { command: 'npm test -- --run src/widget.test.ts', timeoutMs: 900_000 },
    }));
    expect(updateIssue.mock.calls.map((call) => call[1].status)).toEqual(['IN_PROGRESS', 'DONE']);
    expect(runSpec).toHaveBeenCalledWith(expect.stringContaining('# [AD-42] 잘못된 응답'), expect.objectContaining({
      workflowRunId: linkedRunId,
      specSessionId: linkedRunId,
      startStep: 'planner',
      reproCommand: 'npm test -- --run src/widget.test.ts',
      initialFeedback: expect.stringContaining('observed exit code: 1'),
    }));
    expect(insertRun).toHaveBeenCalledWith(expect.objectContaining({
      id: linkedRunId,
      agentName: 'spec',
      status: 'RUNNING',
      specSessionId: linkedRunId,
    }));
  });

  it('returns BLOCKED with not_reproduced and leaves the issue status unchanged when the command passes', async () => {
    runVerifyStep.mockResolvedValueOnce({
      runId: 'repro-command-run',
      passed: false,
      outcome: { exitCode: 0, timedOut: false, cancelled: false, durationMs: 7, outputTail: '1 test passed' },
    });

    const result = await processIssue('AD-42');

    expect(result).toMatchObject({
      verdict: 'BLOCKED',
      finalStatus: 'OPEN',
      cause: 'not_reproduced',
      report: expect.stringContaining('이미 해결됐거나 재현 정보가 부족하다'),
    });
    expect(updateIssue).not.toHaveBeenCalled();
    expect(runSpec).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({
      status: 'BLOCKED',
      errorType: 'not_reproduced',
    }));
  });

  it('blocks and preserves issue status when the repro author edits production files', async () => {
    snapshotWorkspace
      .mockResolvedValueOnce(new Map([['src/widget.ts', 'before']]))
      .mockResolvedValueOnce(new Map([['src/widget.ts', 'after']]));

    const result = await processIssue('AD-42');

    expect(result).toMatchObject({ verdict: 'BLOCKED', cause: 'role_boundary_violation' });
    expect(result.report).toContain('src/widget.ts');
    expect(runVerifyStep).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('keeps ordinary task issues on the existing spec workflow', async () => {
    state.issue.type = 'TASK';

    const result = await processIssue('AD-42');

    expect(result.verdict).toBe('SHIP');
    expect(testAgent).not.toHaveBeenCalled();
    expect(runVerifyStep).not.toHaveBeenCalled();
    expect(runSpec).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ workflowRunId: expect.any(String) }));
    expect(runSpec.mock.calls[0][1]).not.toHaveProperty('reproCommand');
  });

  it('runs Plane issues in an isolated branch, records stage comments, and waits for post-success work', async () => {
    state.provider = 'plane';
    state.issue.type = 'TASK';
    state.issue.id = 'plane-issue-id';
    state.issue.requesterId = 'plane-user-id';
    runSpec.mockImplementationOnce(async (_content: string, options: any) => {
      await options.onStageResult({ stage: 'test', runId: 'test-run-1', status: 'DONE', output: 'Verification decisions recorded.' });
      return runResult({ testRepairCount: 1, planOutput: 'Use a branch-local change.' });
    });

    const result = await processIssue('AD-42', 'api');

    expect(result).toMatchObject({ verdict: 'SHIP', finalStatus: 'DONE' });
    expect(prepareIssueWorktree).toHaveBeenCalledWith('/workspace/project', expect.any(String), 'AD-42', undefined);
    expect(runSpec).toHaveBeenCalledWith(expect.stringContaining('요청자 ID: plane-user-id'), expect.objectContaining({
      cwd: '/worktree/issue',
      projectConfigDir: '/workspace/project',
      triggerSource: 'issue',
      testRepairLimit: 2,
      awaitPostSuccess: true,
      onStageResult: expect.any(Function),
    }));
    expect(issueWorktreeCheckpoint).toHaveBeenCalledOnce();
    expect(addComment).toHaveBeenCalledWith('AD-42', expect.objectContaining({
      externalId: expect.stringContaining(':stage:test:test-run-1'),
      html: expect.stringContaining('checkpoint-sha'),
    }));
    expect(commitIssueWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: 'autodev/issue/ad-42-run' }), 'success', expect.stringContaining('결정 근거'));
    expect(pushIssueWorktree).toHaveBeenCalledWith(expect.anything(), 'commit-sha');
    expect(updateIssue.mock.calls.map((call) => call[1].status)).toEqual(['IN_PROGRESS', 'DONE']);
    expect(removePushedIssueWorktree).toHaveBeenCalledWith(expect.anything(), 'commit-sha');
  });

  it('pushes a WIP branch for exhausted test repairs and moves Plane issues to human review', async () => {
    state.provider = 'plane';
    state.issue.type = 'TASK';
    runSpec.mockResolvedValueOnce(runResult({
      verdict: 'FAILED',
      testRepairCount: 2,
      failure: { step: 'verify', cause: 'test_repair_limit_exhausted', reason: 'verification still fails' },
    }));

    const result = await processIssue('AD-42', 'poll');

    expect(result).toMatchObject({ verdict: 'FAILED', finalStatus: 'HUMAN_REVIEW', cause: 'test_repair_limit_exhausted' });
    expect(commitIssueWorktree).toHaveBeenCalledWith(expect.anything(), 'wip', expect.stringContaining('verification still fails'));
    expect(updateIssue.mock.calls.map((call) => call[1].status)).toEqual(['IN_PROGRESS', 'HUMAN_REVIEW']);
    expect(finishIssueExecution).toHaveBeenCalledWith(expect.any(String), 'HUMAN_REVIEW', expect.objectContaining({ commitSha: 'commit-sha' }));
  });

  it('keeps the issue locked and retries when a Plane branch push fails', async () => {
    state.provider = 'plane';
    state.issue.type = 'TASK';
    runSpec.mockResolvedValueOnce(runResult({ verdict: 'FAILED', failure: { reason: 'review requested changes' } }));
    pushIssueWorktree.mockRejectedValueOnce(new Error('remote rejected push'));

    const result = await processIssue('AD-42', 'api');

    expect(result).toMatchObject({ verdict: 'FAILED', finalStatus: 'IN_PROGRESS', cause: 'push_pending' });
    expect(updateIssueExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'DELIVERY_PENDING',
      target_status: 'HUMAN_REVIEW',
      last_error: 'remote rejected push',
    }));
    expect(finishIssueExecution).not.toHaveBeenCalled();
    expect(removePushedIssueWorktree).not.toHaveBeenCalled();
  });
});
