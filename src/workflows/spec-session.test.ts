import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

const specInputs: string[] = [];
const specOptions: any[] = [];
let specResult: any;

const { commitSuccessfulSpec } = vi.hoisted(() => ({
  commitSuccessfulSpec: vi.fn(async () => ({ steps: {} })),
}));
vi.mock('./post-success-commit.js', () => ({ commitSuccessfulSpec }));

vi.mock('./spec.js', () => ({
  STEP_ORDER: ['clarifier', 'planner', 'scaffold', 'test', 'review', 'cicd'],
  runSpec: vi.fn(async (input: string, opts: any) => {
    specInputs.push(input);
    specOptions.push(opts);
    return specResult;
  }),
  workflowOutput: (result: any) => {
    const summary = Object.entries(result.steps ?? {}).map(([k, v]: any) => `${k}: ${v.status}`).join(', ');
    return result.verdict ? `${summary}\nverdict: ${result.verdict}` : summary;
  },
  workflowRunStatus: (result: any) => (
    result.verdict === 'BLOCKED' || result.verdict === 'FAILED' || result.verdict === 'NEEDS-WORK' ? 'FAILED' : 'DONE'
  ),
}));

const inserted: any[] = [];
const updates: any[] = [];
let childRuns: any[] = [];
const runRows = new Map<string, any>();
vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn((row: any) => inserted.push(row)),
  updateRun: vi.fn((id: string, patch: any) => updates.push({ id, ...patch })),
  getRun: vi.fn((id: string) => runRows.get(id)),
  getRunsByWorkflowId: vi.fn(() => childRuns),
}));

const stateStore = new Map<string, any>();
const saveClarificationState = vi.fn((id: string, state: any) => stateStore.set(id, state));
const getClarificationState = vi.fn((id: string) => stateStore.get(id));
vi.mock('../store/clarification.js', () => ({
  saveClarificationState: (id: string, s: any) => saveClarificationState(id, s),
  getClarificationState: (id: string) => getClarificationState(id),
}));

const emitRunEvent = vi.fn();
const closeEmitter = vi.fn();
vi.mock('../lib/run-events.js', () => ({
  emitRunEvent: (...args: any[]) => emitRunEvent(...args),
  closeEmitter: (...args: any[]) => closeEmitter(...args),
}));

const notifyOpenClawSpec = vi.fn(async (_notice: any) => true);
vi.mock('../integrations/openclaw/notify.js', () => ({
  notifyOpenClawSpec: (notice: any) => notifyOpenClawSpec(notice),
}));

const writes: Array<{ path: string; content: string }> = [];
vi.mock('fs', () => ({
  writeFileSync: vi.fn((path: string, content: string) => writes.push({ path, content })),
  mkdirSync: vi.fn(),
}));

const { loadProjectConfig } = vi.hoisted(() => ({ loadProjectConfig: vi.fn(() => undefined as any) }));
vi.mock('../lib/project-config.js', () => ({ loadProjectConfig }));
const deliveryMocks = vi.hoisted(() => ({
  preparePullRequestWorktree: vi.fn((_sourceDir: string, workflowRunId: string) => ({
    workflowRunId, sourceDir: '/tmp/proj', worktreeDir: '/tmp/worktrees/pr-run', remote: 'origin',
    repository: 'org/project', branch: 'autodev/pr-run', baseBranch: 'main', baseSha: 'head-sha',
    publicBaseUrl: 'https://dashboard.example.test', accessControl: 'authenticated', state: { status: 'READY' },
  })),
  validatePullRequestDeliveryContext: vi.fn(),
  completePullRequestDelivery: vi.fn(),
}));
vi.mock('../lib/pr-delivery.js', () => deliveryMocks);
const workspaceMocks = vi.hoisted(() => ({
  snapshotWorkspace: vi.fn(async () => new Map<string, string>()),
  workspaceHeadSha: vi.fn(async () => 'head-sha' as string | undefined),
}));
vi.mock('../lib/role-boundary.js', () => workspaceMocks);
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_command: string, args: string[]) => args.includes('status') ? '' : 'head-sha'),
}));

const recoveryFixtures = vi.hoisted(() => ({ expired: [] as any[], claimed: undefined as any }));
const checkpointMocks = vi.hoisted(() => ({
  createCheckpointLeaseOwner: vi.fn(() => 'test-owner'),
  createWorkflowCheckpoint: vi.fn((workflowRunId: string, snapshot: any, leaseOwner: string) => ({
    workflowRunId, schemaVersion: 1, revision: 1, state: 'RUNNING', snapshot,
    leaseOwner, updatedAt: new Date().toISOString(),
  })),
  finishWorkflowCheckpoint: vi.fn(() => 2),
  heartbeatWorkflowCheckpoint: vi.fn(() => true),
  updateWorkflowCheckpoint: vi.fn(() => 2),
  listExpiredWorkflowCheckpoints: vi.fn(() => recoveryFixtures.expired),
  claimExpiredWorkflowCheckpoint: vi.fn((_runId: string, leaseOwner: string, revision: number) => recoveryFixtures.claimed
    ? { ...recoveryFixtures.claimed, leaseOwner, revision: revision + 1 }
    : undefined),
  getWorkflowCheckpoint: vi.fn(),
  claimWorkflowDeliveryRetry: vi.fn(),
}));
vi.mock('../store/workflow-checkpoints.js', () => checkpointMocks);

import { startSpecSession, resumeSpecSession, continueSpecSession, resumeLastSpecStep, pendingClarification, specRunPlan, recoverExpiredWorkflowCheckpoints } from './spec-session.js';

const Q1 = { id: 'q1', category: 'scope', text: '범위는?', recommendation: '핵심 CRUD' };

beforeEach(() => {
  specInputs.length = 0;
  specOptions.length = 0;
  inserted.length = 0;
  updates.length = 0;
  writes.length = 0;
  childRuns = [];
  runRows.clear();
  recoveryFixtures.expired.length = 0;
  recoveryFixtures.claimed = undefined;
  stateStore.clear();
  saveClarificationState.mockClear();
  getClarificationState.mockClear();
  emitRunEvent.mockClear();
  closeEmitter.mockClear();
  notifyOpenClawSpec.mockClear();
  loadProjectConfig.mockReturnValue(undefined);
  deliveryMocks.preparePullRequestWorktree.mockClear();
  deliveryMocks.validatePullRequestDeliveryContext.mockClear();
  checkpointMocks.createWorkflowCheckpoint.mockClear();
  checkpointMocks.finishWorkflowCheckpoint.mockClear();
  checkpointMocks.updateWorkflowCheckpoint.mockClear();
  workspaceMocks.snapshotWorkspace.mockResolvedValue(new Map());
  workspaceMocks.snapshotWorkspace.mockClear();
  workspaceMocks.workspaceHeadSha.mockResolvedValue('head-sha');
  workspaceMocks.workspaceHeadSha.mockClear();
});

describe('startSpecSession (round 0)', () => {
  it('runs the bare spec, persists clarification state, and writes the plan file on gate', async () => {
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'NEEDS-CLARIFICATION' } },
      totalDurationMs: 5,
      verdict: 'NEEDS-CLARIFICATION',
      clarification: { summary: '', questions: [Q1] },
    };

    const { runId, done } = startSpecSession('사용자 관리 기능', {
      project: 'my-api', cwd: '/tmp/proj', triggerSource: 'dashboard',
    });
    await done;

    expect(specInputs).toEqual(['사용자 관리 기능']);

    const saved = stateStore.get(runId);
    expect(saved.sessionId).toBe(runId);
    expect(saved.spec).toBe('사용자 관리 기능');
    expect(saved.slug).toBe('my-api');
    expect(saved.planFile).toBe('docs/plan/my-api.md');
    expect(saved.cwd).toBe('/tmp/proj');
    expect(saved.rounds).toEqual([{ questions: [Q1] }]);

    const plan = writes.find(w => w.path === '/tmp/proj/docs/plan/my-api.md');
    expect(plan).toBeDefined();
    expect(plan!.content).toContain('사용자 관리 기능');
    expect(emitRunEvent).toHaveBeenCalledWith(runId, expect.objectContaining({ type: 'status', data: 'DONE' }));
    expect(closeEmitter).toHaveBeenCalledWith(runId);
    expect(notifyOpenClawSpec).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      project: 'my-api',
      verdict: 'NEEDS-CLARIFICATION',
      clarificationCount: 1,
    }));
  });

  it('serializes a partial steps filter into clarification state', async () => {
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { runId, done } = startSpecSession('사용자 관리 기능', {
      project: 'my-api',
      cwd: '/tmp/proj',
      steps: new Set(['clarifier', 'planner']),
      iterations: 6,
    });
    await done;

    expect(stateStore.get(runId).steps).toEqual(['clarifier', 'planner']);
    expect(stateStore.get(runId).iterations).toBe(6);
    expect(specOptions[0].steps).toEqual(new Set(['clarifier', 'planner']));
    expect(specOptions[0].iterations).toBe(6);
  });

  it('passes the default CI intent into the workflow', async () => {
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { done } = startSpecSession('사용자 관리 기능', {
      project: 'my-api',
      cwd: '/tmp/proj',
      triggerSource: 'dashboard',
    });
    await done;

    expect(specOptions[0].deliveryIntent).toBe('ci');
  });

  it('passes the configured auto-clarify round limit into the workflow', async () => {
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { done } = startSpecSession('사용자 관리 기능', {
      project: 'my-api',
      cwd: '/tmp/proj',
      autoClarify: true,
      maxClarifyRounds: 0,
    });
    await done;

    expect(specOptions[0].autoClarify).toBe(true);
    expect(specOptions[0].maxClarifyRounds).toBe(0);
  });

  it('creates and finishes a checkpoint only for explicitly opted-in dashboard sessions', async () => {
    loadProjectConfig.mockReturnValue({ version: 1, workflow: { resumeOnRestart: true } });
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { runId, done } = startSpecSession('재시작 복구 기능', {
      project: 'my-api', cwd: '/tmp/proj', triggerSource: 'dashboard',
    });
    await done;

    expect(checkpointMocks.createWorkflowCheckpoint).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ kind: 'dashboard-spec-session', workflowRunId: runId, configFingerprint: expect.any(String) }),
      'test-owner',
    );
    expect(specOptions[0].checkpoint.initialState).toMatchObject({ cursor: 0, routeCount: 0, clarifiedSpec: expect.any(String) });
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      runId,
      expect.any(Object),
      'SUCCEEDED',
      'test-owner',
      1,
      expect.objectContaining({ status: 'DONE', output: expect.stringContaining('SHIP') }),
    );
  });

  it('preflights PR delivery and starts the workflow inside a run-only worktree with an implied checkpoint', async () => {
    loadProjectConfig.mockReturnValue({ version: 1, delivery: { mode: 'pull-request' } });
    specResult = {
      workflowRunId: 'x',
      steps: { clarifier: { runId: 'c', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
      delivery: { status: 'DELIVERED', prUrl: 'https://github.com/org/project/pull/1' },
    };

    const { runId, done } = startSpecSession('PR 전달 기능', {
      project: 'my-api', cwd: '/tmp/proj', triggerSource: 'dashboard',
    });
    await done;

    expect(deliveryMocks.preparePullRequestWorktree).toHaveBeenCalledWith(
      '/tmp/proj', runId, { mode: 'pull-request' }, process.env,
    );
    expect(stateStore.get(runId)).toMatchObject({
      cwd: '/tmp/worktrees/pr-run', sourceCwd: '/tmp/proj',
      deliveryContext: { workflowRunId: runId, dashboardRunId: runId },
    });
    expect(specOptions.at(-1)).toMatchObject({
      cwd: '/tmp/worktrees/pr-run', projectConfigDir: '/tmp/proj',
      deliveryContext: { repository: 'org/project' }, checkpoint: expect.any(Object),
    });
    expect(checkpointMocks.createWorkflowCheckpoint).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ deliveryContext: expect.objectContaining({ branch: 'autodev/pr-run' }) }),
      'test-owner',
    );
    const finishCall = (checkpointMocks.finishWorkflowCheckpoint.mock.calls as unknown as any[][]).at(-1);
    expect(finishCall?.[5].output).toContain('PR: https://github.com/org/project/pull/1');
  });

  it('keeps code success as DONE while exposing a failed external PR delivery as DELIVERY_PENDING', async () => {
    loadProjectConfig.mockReturnValue({ version: 1, delivery: { mode: 'pull-request' } });
    specResult = {
      workflowRunId: 'x', steps: {}, totalDurationMs: 5, verdict: 'SHIP',
      delivery: { status: 'DELIVERY_PENDING', stage: 'push', reason: 'network unavailable' },
    };

    const { runId, done } = startSpecSession('PR 전달 장애 처리', { cwd: '/tmp/proj', triggerSource: 'dashboard' });
    await done;

    const finishCall = (checkpointMocks.finishWorkflowCheckpoint.mock.calls as unknown as any[][]).at(-1);
    expect(finishCall?.[2]).toBe('DELIVERY_PENDING');
    expect(finishCall?.[5]).toMatchObject({ status: 'DONE', output: expect.stringContaining('network unavailable') });
    expect(runId).toBe(finishCall?.[0]);
  });
});

describe('resumeSpecSession (round N)', () => {
  it('keeps auto-clarify enabled after a clarification stop', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      autoClarify: true,
      maxClarifyRounds: 0,
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD' });
    await done;

    expect(specOptions[0].autoClarify).toBe(true);
    expect(specOptions[0].maxClarifyRounds).toBe(0);
    expect(stateStore.get(runId).autoClarify).toBe(true);
  });

  it('allows the answer form to enable auto-clarify for a legacy stopped run', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      iterations: 6,
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { done } = resumeSpecSession('parent', { q1: 'CRUD' }, undefined, undefined, {
      autoClarify: true,
      maxClarifyRounds: 0,
    });
    await done;

    expect(specOptions[0].autoClarify).toBe(true);
    expect(specOptions[0].maxClarifyRounds).toBe(0);
  });

  it('feeds spec + answers to the workflow and writes the plan with the planner output', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      iterations: 6,
      rounds: [{ questions: [Q1] }],
    });

    specResult = {
      workflowRunId: 'y',
      steps: { clarifier: { runId: 'c2', durationMs: 5, status: 'DONE' }, planner: { runId: 'p', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 10,
      verdict: 'SHIP',
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD + 검색' });
    await done;

    expect(specInputs[0]).toContain('사용자 관리 기능');
    expect(specInputs[0]).toContain('답: CRUD + 검색');

    const plan = writes.find(w => w.path === '/tmp/proj/docs/plan/my-api.md');
    expect(plan!.content).toContain('CRUD + 검색');
    expect(plan!.content).toContain('1. scaffold | build');

    expect(updates.find(u => u.id === runId && u.status === 'DONE')).toBeDefined();
    // launch 가 항상 상태를 영속화하므로 재개한 run 도 이어갈 수 있다.
    expect(saveClarificationState).toHaveBeenCalled();
    expect(inserted.find(r => r.id === runId).workflowRunId).toBeUndefined();
    expect(inserted.find(r => r.id === runId).triggerDetail).toBe('answers:parent');
    expect(inserted.find(r => r.id === runId).specSessionId).toBe('parent');
    expect(specOptions[0].workflowRunId).toBe(runId);
    expect(specOptions[0].specSessionId).toBe('parent');
    expect(specOptions[0].iterations).toBe(6);
    expect(stateStore.get('parent').rounds.at(-1).answers).toEqual({ q1: 'CRUD + 검색' });
    expect(stateStore.get(runId).rounds.at(-1).answers).toEqual({ q1: 'CRUD + 검색' });
  });

  it('recovers a missing pending round with fallback questions from the UI', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD + 검색' }, undefined, [Q1]);
    await done;

    expect(specInputs[0]).toContain('범위는?');
    expect(specInputs[0]).toContain('답: CRUD + 검색');
    expect(inserted.find(r => r.id === runId).workflowRunId).toBeUndefined();
    expect(stateStore.get('parent').rounds).toEqual([{ questions: [Q1], answers: { q1: 'CRUD + 검색' } }]);
    expect(stateStore.get(runId).rounds).toEqual([{ questions: [Q1], answers: { q1: 'CRUD + 검색' } }]);
  });
});

describe('workflow checkpoint recovery', () => {
  const config = { version: 1 as const, workflow: { resumeOnRestart: true } };

  function checkpoint(activeAction: string, overrides: Record<string, unknown> = {}) {
    const workflowState = {
      cursor: 2,
      executed: 1,
      routeCount: 0,
      clarifiedSpec: '복구 스펙',
      planOutput: 'PLAN:\n1. scaffold | feature\nEND.',
      results: {},
      runtimeEvidenceSummary: '',
      autoClarifyRounds: [],
      autoQaLines: [],
      initialFeedbackApplied: false,
      activeAction,
      activeStep: activeAction === 'agent' ? 'scaffold' : activeAction,
      actionStartedAt: '2026-10-16T00:00:00.000Z',
      beforeSnapshot: {},
      beforeHeadSha: 'head-sha',
      ...overrides,
    };
    const snapshot = {
      kind: 'dashboard-spec-session',
      workflowRunId: 'recover-run',
      configFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      sessionState: {
        spec: '복구 스펙', project: 'my-api', slug: 'my-api', planFile: 'docs/plan/my-api.md',
        cwd: '/tmp/proj', rounds: [],
      },
      specInput: '복구 스펙',
      options: { project: 'my-api', cwd: '/tmp/proj', triggerSource: 'dashboard' },
      workflowState,
      ...workflowState,
      baseHeadSha: 'head-sha',
      baseSnapshot: {},
    };
    return {
      workflowRunId: 'recover-run', schemaVersion: 1, revision: 4, state: 'RUNNING',
      snapshot, leaseOwner: JSON.stringify({ host: hostname(), pid: 99999999, nonce: 'old' }),
      updatedAt: '2026-10-16T00:00:00.000Z', leaseExpiresAt: '2026-10-16T00:01:00.000Z',
    };
  }

  beforeEach(() => {
    loadProjectConfig.mockReturnValue(config);
    runRows.set('recover-run', { id: 'recover-run', status: 'RUNNING', started_at: '2026-10-16T00:00:00.000Z' });
  });

  it('resumes an interrupted agent from its saved cursor when workspace hashes match', async () => {
    const pending = checkpoint('agent', { activeStep: 'planner', cursor: 1, executed: 0 });
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;
    specResult = {
      workflowRunId: 'recover-run', steps: { scaffold: { runId: 'new-scaffold', durationMs: 3, status: 'DONE' } },
      totalDurationMs: 3, verdict: 'SHIP',
    };

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);
    await new Promise(resolve => setImmediate(resolve));

    expect(specInputs).toContain('복구 스펙');
    expect(specOptions.at(-1).checkpoint.initialState).toMatchObject({ cursor: 1, activeAction: 'agent', activeStep: 'planner' });
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      'recover-run', expect.any(Object), 'SUCCEEDED', 'test-owner', 5, expect.any(Object),
    );
  });

  it('reuses a completed child output even when the workspace changed', async () => {
    const pending = checkpoint('agent', { activeRunId: 'saved-child' });
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;
    runRows.set('saved-child', {
      id: 'saved-child', agent_name: 'scaffold', status: 'DONE', output: 'finished',
      tokens_in: 11, tokens_out: 12, duration_ms: 13,
    });
    specResult = { workflowRunId: 'recover-run', steps: {}, totalDurationMs: 2, verdict: 'SHIP' };

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);
    await new Promise(resolve => setImmediate(resolve));

    expect(workspaceMocks.snapshotWorkspace).not.toHaveBeenCalled();
    expect(specOptions.at(-1).checkpoint.recoveredResult).toEqual({
      runId: 'saved-child', output: 'finished', tokensIn: 11, tokensOut: 12, durationMs: 13, status: 'DONE',
    });
  });

  it('requires manual recovery when an interrupted agent changed workspace files', async () => {
    const pending = checkpoint('agent', { activeStep: 'planner', cursor: 1, beforeSnapshot: { 'src/app.ts': 'before' } });
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;
    workspaceMocks.snapshotWorkspace.mockResolvedValue(new Map([['src/app.ts', 'after']]));

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);

    expect(specInputs).toHaveLength(0);
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      'recover-run', expect.objectContaining({ recoveryReason: expect.stringContaining('워크스페이스') }),
      'RECOVERY_REQUIRED', 'test-owner', 5,
      expect.objectContaining({ errorType: 'workflow_recovery_required' }),
    );
  });

  it('does not replay an interrupted write-capable agent even when tracked hashes match', async () => {
    const pending = checkpoint('agent');
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);

    expect(specInputs).toHaveLength(0);
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      'recover-run', expect.objectContaining({ recoveryReason: expect.stringContaining('파일 쓰기 권한') }),
      'RECOVERY_REQUIRED', 'test-owner', 5,
      expect.objectContaining({ errorType: 'workflow_recovery_required' }),
    );
  });

  it('marks interrupted internal verification as recovery required', async () => {
    const pending = checkpoint('verify', { activeStep: 'verify' });
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);

    expect(specInputs).toHaveLength(0);
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      'recover-run', expect.objectContaining({ recoveryReason: expect.stringContaining('verify') }), 'RECOVERY_REQUIRED', 'test-owner', 5,
      expect.objectContaining({ status: 'FAILED', errorType: 'workflow_recovery_required' }),
    );
  });

  it('reconciles an interrupted PR push/PR stage without restarting workflow agents', async () => {
    const prConfig = { version: 1 as const, delivery: { mode: 'pull-request' as const } };
    loadProjectConfig.mockReturnValue(prConfig);
    const pending = checkpoint('delivery', { activeStep: 'push' }) as any;
    const context = {
      workflowRunId: 'recover-run', dashboardRunId: 'recover-run', sourceDir: '/tmp/proj',
      worktreeDir: '/tmp/worktrees/recover-run', remote: 'origin', repository: 'org/project',
      branch: 'autodev/recover', baseBranch: 'main', baseSha: 'head-sha',
      publicBaseUrl: 'https://dashboard.example.test', accessControl: 'authenticated',
    };
    pending.snapshot.sessionState.deliveryContext = context;
    pending.snapshot.deliveryContext = context;
    pending.snapshot.deliveryState = { status: 'READY', stage: 'push', commitSha: 'commit-sha' };
    pending.snapshot.configFingerprint = createHash('sha256').update(JSON.stringify(prConfig)).digest('hex');
    recoveryFixtures.expired.push(pending);
    recoveryFixtures.claimed = pending;
    deliveryMocks.completePullRequestDelivery.mockResolvedValue({
      status: 'DELIVERED', stage: 'pull-request', commitSha: 'commit-sha', prUrl: 'https://github.com/org/project/pull/1',
    });

    expect(await recoverExpiredWorkflowCheckpoints()).toBe(1);

    expect(specInputs).toHaveLength(0);
    expect(deliveryMocks.validatePullRequestDeliveryContext).toHaveBeenCalledWith(context, process.env);
    expect(deliveryMocks.completePullRequestDelivery).toHaveBeenCalledOnce();
    expect(checkpointMocks.finishWorkflowCheckpoint).toHaveBeenCalledWith(
      'recover-run', expect.any(Object), 'SUCCEEDED', 'test-owner', 5,
      expect.objectContaining({ status: 'DONE', output: expect.stringContaining('https://github.com/org/project/pull/1') }),
    );
  });
});

describe('resumeSpecSession with extra instruction', () => {
  it('attaches an extra instruction alongside the answers', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj',
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 10, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD' }, '검색에 페이지네이션도 넣어줘');
    await done;

    expect(specInputs[0]).toContain('답: CRUD');
    expect(specInputs[0]).toContain('검색에 페이지네이션도 넣어줘');
    const last = stateStore.get(runId).rounds.at(-1);
    expect(last.answers).toEqual({ q1: 'CRUD' });
    expect(last.followup).toBe('검색에 페이지네이션도 넣어줘');
  });

  it('allows resuming with only an extra instruction (no answers)', async () => {
    stateStore.set('parent', {
      spec: 's', project: 'p', slug: 'p', planFile: 'docs/plan/p.md', cwd: '/c',
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', {}, '방향을 바꿔줘');
    await done;

    expect(specInputs[0]).toContain('방향을 바꿔줘');
    expect(stateStore.get(runId).rounds.at(-1).followup).toBe('방향을 바꿔줘');
  });

  it('ignores a blank extra instruction', async () => {
    stateStore.set('parent', {
      spec: 's', project: 'p', slug: 'p', planFile: 'docs/plan/p.md', cwd: '/c',
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD' }, '   ');
    await done;

    expect(stateStore.get(runId).rounds.at(-1).followup).toBeUndefined();
  });
});

describe('continueSpecSession', () => {
  it('appends a follow-up round, re-runs the full spec, and stays continuable', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD' } }],
    });

    specResult = {
      workflowRunId: 'z',
      steps: { scaffold: { runId: 's', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { runId, done } = continueSpecSession('parent', '삭제는 soft delete 로');
    await done;

    // 원본 spec + 이전 Q&A + 새 후속지시가 합쳐져 워크플로우에 전달된다
    expect(specInputs[0]).toContain('사용자 관리 기능');
    expect(specInputs[0]).toContain('답: CRUD');
    expect(specInputs[0]).toContain('삭제는 soft delete 로');

    // 새 run 은 부모와 다른 id 이고, 추적용 triggerDetail 을 기록한다
    expect(runId).not.toBe('parent');
    expect(inserted.find(r => r.id === runId).triggerDetail).toBe('continue:parent');

    // 새 run 도 상태가 저장돼 다시 이어갈 수 있다 (후속지시 라운드 포함)
    expect(stateStore.get(runId).rounds.at(-1).followup).toBe('삭제는 soft delete 로');

    const plan = writes.find(w => w.path === '/tmp/proj/docs/plan/my-api.md');
    expect(plan!.content).toContain('삭제는 soft delete 로');
  });

  it('throws when the parent run has no stored state', () => {
    expect(() => continueSpecSession('missing', '뭔가')).toThrow(/No clarification state/);
  });

  it('allows a blank instruction and reruns from the same stored state', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD' } }],
    });
    specResult = {
      workflowRunId: 'z',
      steps: { scaffold: { runId: 's', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
    };

    const { runId, done } = continueSpecSession('parent', '   ');
    await done;

    expect(runId).not.toBe('parent');
    expect(specInputs[0]).toContain('사용자 관리 기능');
    expect(inserted.find(r => r.id === runId).triggerDetail).toBe('continue:parent');
  });
});

describe('resumeLastSpecStep', () => {
  it('starts a new run from the last executed workflow step and reuses the stored plan', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD' } }],
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    });
    childRuns = [
      { agent_name: 'clarifier', status: 'DONE' },
      { agent_name: 'planner', status: 'DONE' },
      { agent_name: 'scaffold', status: 'DONE' },
      { agent_name: 'test', status: 'DONE' },
      { agent_name: 'review', status: 'FAILED' },
    ];
    specResult = {
      workflowRunId: 'r',
      steps: { review: { runId: 'review-2', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    };

    const { runId, done } = resumeLastSpecStep('parent');
    await done;

    expect(runId).not.toBe('parent');
    expect(inserted.find(r => r.id === runId).triggerDetail).toBe('resume:parent:review');
    expect(specOptions[0].startStep).toBe('review');
    expect(specOptions[0].initialPlanOutput).toBe('PLAN:\n1. scaffold | build\nEND.');
    expect(specOptions[0].initialFeedback).toBeUndefined();
    expect(updates.find(u => u.id === runId && u.status === 'DONE')).toBeDefined();
  });

  it('passes resume-last instructions as one-time initial feedback', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD' } }],
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    });
    childRuns = [
      { agent_name: 'clarifier', status: 'DONE' },
      { agent_name: 'planner', status: 'DONE' },
      { agent_name: 'scaffold', status: 'DONE' },
      { agent_name: 'test', status: 'DONE' },
      { agent_name: 'review', status: 'FAILED' },
    ];
    specResult = {
      workflowRunId: 'r',
      steps: { review: { runId: 'review-2', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'SHIP',
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    };

    const { done } = resumeLastSpecStep('parent', '리뷰에서 지적한 내용을 반영해');
    await done;

    expect(specOptions[0].initialFeedback).toBe('리뷰에서 지적한 내용을 반영해');
  });

  it('resumes at the routed planner after a completed review requests changes', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj', rounds: [], planOutput: 'PLAN',
    });
    childRuns = [{
      agent_name: 'review', status: 'DONE',
      output: 'Finding: broken contract\n[VERDICT: NEEDS-WORK]\n[ROUTE: planner]',
    }];
    specResult = { workflowRunId: 'r', steps: {}, totalDurationMs: 1, verdict: 'SHIP', planOutput: 'PLAN' };

    const { done } = resumeLastSpecStep('parent');
    await done;

    expect(specOptions[0].startStep).toBe('planner');
    expect(specOptions[0].initialFeedback).toContain('Finding: broken contract');
  });

  it('resumes a review with no verdict or route markers at planner', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj', rounds: [], planOutput: 'PLAN',
    });
    childRuns = [{
      agent_name: 'review', status: 'DONE',
      output: 'Review found a high-impact regression that requires code changes.',
    }];
    specResult = { workflowRunId: 'r', steps: {}, totalDurationMs: 1, verdict: 'SHIP', planOutput: 'PLAN' };

    const { done } = resumeLastSpecStep('parent');
    await done;

    expect(specOptions[0].startStep).toBe('planner');
    expect(specOptions[0].initialFeedback).toContain('Review found a high-impact regression');
  });

  it('continues to the next step after a completed agent instead of rerunning it', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj', rounds: [], planOutput: 'PLAN',
    });
    childRuns = [{ agent_name: 'test', status: 'DONE', output: '[TESTS: PASS]' }];
    specResult = { workflowRunId: 'r', steps: {}, totalDurationMs: 1, verdict: 'SHIP', planOutput: 'PLAN' };

    const { done } = resumeLastSpecStep('parent');
    await done;

    expect(specOptions[0].startStep).toBe('review');
    expect(specOptions[0].initialFeedback).toBeUndefined();
  });

  it('overrides the auto-detected step when startStepOverride is given', async () => {
    // clarifier 가 유효하지 않은(JSON이 아닌) 응답으로 막힌 경우, 자동 판단은 planner를
    // 고르지만 사용자가 명시적으로 scaffold부터 재개하도록 강제할 수 있어야 한다.
    stateStore.set('parent', {
      spec: '이 섹션을 위로 옮기고 기존 섹션은 삭제해줘', slug: 's', planFile: 'docs/plan/s.md',
      cwd: '/tmp/proj', rounds: [],
    });
    childRuns = [{ agent_name: 'clarifier', status: 'DONE', output: 'I need to clarify my role...' }];
    specResult = { workflowRunId: 'r', steps: {}, totalDurationMs: 1, verdict: 'SHIP', planOutput: 'PLAN' };

    const { done } = resumeLastSpecStep('parent', undefined, 'scaffold');
    await done;

    expect(specOptions[0].startStep).toBe('scaffold');
    expect(specOptions[0].initialFeedback).toBeUndefined();
  });

  it('marks NEEDS-WORK workflow verdicts as FAILED', async () => {
    stateStore.set('parent', {
      spec: 's', slug: 's', planFile: 'docs/plan/s.md', cwd: '/tmp/proj', rounds: [],
      planOutput: 'PLAN',
    });
    childRuns = [{ agent_name: 'review', status: 'DONE' }];
    specResult = {
      workflowRunId: 'r',
      steps: { review: { runId: 'review-2', durationMs: 5, status: 'DONE' } },
      totalDurationMs: 5,
      verdict: 'NEEDS-WORK',
      planOutput: 'PLAN',
    };

    const { runId, done } = resumeLastSpecStep('parent');
    await done;

    expect(updates.find(u => u.id === runId && u.status === 'FAILED')).toBeDefined();
  });
});

describe('partial steps persistence across resumes', () => {
  it('restores stored steps when answering a clarification round', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      steps: ['clarifier', 'planner'],
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD' });
    await done;

    expect(specOptions[0].steps).toEqual(new Set(['clarifier', 'planner']));
    expect(stateStore.get(runId).steps).toEqual(['clarifier', 'planner']);
  });

  it('restores stored steps when continuing a completed run', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      steps: ['planner', 'review'],
      rounds: [],
    });
    specResult = { workflowRunId: 'z', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = continueSpecSession('parent', '리뷰만 다시 확인해');
    await done;

    expect(specOptions[0].steps).toEqual(new Set(['planner', 'review']));
    expect(stateStore.get(runId).steps).toEqual(['planner', 'review']);
  });

  it('restores stored steps when resuming from the last executed step', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      steps: ['test', 'review'],
      rounds: [],
      planOutput: 'PLAN',
    });
    childRuns = [{ agent_name: 'review', status: 'FAILED' }];
    specResult = { workflowRunId: 'r', steps: {}, totalDurationMs: 1, verdict: 'SHIP', planOutput: 'PLAN' };

    const { runId, done } = resumeLastSpecStep('parent');
    await done;

    expect(specOptions[0].steps).toEqual(new Set(['test', 'review']));
    expect(specOptions[0].startStep).toBe('review');
    expect(stateStore.get(runId).steps).toEqual(['test', 'review']);
  });

  it('leaves steps undefined for full-pipeline sessions', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [{ questions: [Q1] }],
    });
    specResult = { workflowRunId: 'y', steps: {}, totalDurationMs: 1, verdict: 'SHIP' };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD' });
    await done;

    expect(specOptions[0].steps).toBeUndefined();
    expect(stateStore.get(runId).steps).toBeUndefined();
  });
});

describe('plan persistence + retrieval', () => {
  it('persists planOutput in the run state so the plan can be shown later', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj',
      rounds: [{ questions: [Q1] }],
    });
    specResult = {
      workflowRunId: 'y', steps: {}, totalDurationMs: 10, verdict: 'SHIP',
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    };

    const { runId, done } = resumeSpecSession('parent', { q1: 'CRUD + 검색' });
    await done;

    expect(stateStore.get(runId).planOutput).toBe('PLAN:\n1. scaffold | build\nEND.');
  });

  it('keeps the previous plan when this run produced none (gate stop)', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD' } }],
      planOutput: '이전 플랜',
    });
    specResult = {
      workflowRunId: 'g', steps: {}, totalDurationMs: 5, verdict: 'NEEDS-CLARIFICATION',
      clarification: { summary: '', questions: [Q1] },
    };

    const { runId, done } = continueSpecSession('parent', '추가 지시');
    await done;

    expect(stateStore.get(runId).planOutput).toBe('이전 플랜');
  });

  it('specRunPlan renders the stored plan doc (spec + Q&A + plan)', () => {
    stateStore.set('run', {
      spec: '사용자 관리 기능', project: 'my-api', slug: 'my-api',
      planFile: 'docs/plan/my-api.md', cwd: '/tmp/proj',
      rounds: [{ questions: [Q1], answers: { q1: 'CRUD + 검색' } }],
      planOutput: 'PLAN:\n1. scaffold | build\nEND.',
    });
    const doc = specRunPlan('run');
    expect(doc).toContain('사용자 관리 기능');
    expect(doc).toContain('CRUD + 검색');
    expect(doc).toContain('1. scaffold | build');
  });

  it('specRunPlan returns undefined when the run has no stored state', () => {
    expect(specRunPlan('missing')).toBeUndefined();
  });
});

describe('pendingClarification', () => {
  it('returns the questions of the last unanswered round', () => {
    stateStore.set('run', { spec: 's', slug: 's', planFile: 'p', cwd: '/c', rounds: [{ questions: [Q1] }] });
    expect(pendingClarification('run')).toEqual({ questions: [Q1] });
  });

  it('returns undefined when the last round is already answered', () => {
    stateStore.set('run', { spec: 's', slug: 's', planFile: 'p', cwd: '/c', rounds: [{ questions: [Q1], answers: { q1: 'done' } }] });
    expect(pendingClarification('run')).toBeUndefined();
  });

  it('returns undefined when the run has no clarification state', () => {
    expect(pendingClarification('missing')).toBeUndefined();
  });
});
