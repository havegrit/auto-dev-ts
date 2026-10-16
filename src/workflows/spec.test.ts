import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls: string[] = [];
const inputs: Record<string, string[]> = {
  clarifier: [],
  planner: [],
  scaffold: [],
  test: [],
  review: [],
  cicd: [],
};
let clarifierResult: any;
let clarifierQueue: any[] = [];
let plannerResult: any;
const { commitSuccessfulSpec } = vi.hoisted(() => ({
  commitSuccessfulSpec: vi.fn(async (): Promise<any> => ({ steps: {} })),
}));

vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock('../agents/clarifier.js', () => ({
  clarifier: vi.fn(async (input: string) => {
    calls.push('clarifier');
    inputs.clarifier.push(input);
    if (clarifierQueue.length) return clarifierQueue.shift();
    return clarifierResult ?? {
      runId: 'clarifier-run',
      output: JSON.stringify({
        ready: false,
        summary: '',
        questions: [
          {
            id: 'q1',
            category: 'scope',
            text: '어떤 범위까지 구현할까요?',
            recommendation: '첫 릴리스는 핵심 CRUD만 포함합니다.',
          },
        ],
      }),
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };
  }),
}));

vi.mock('../agents/planner.js', () => ({
  planner: vi.fn(async (input: string) => {
    calls.push('planner');
    inputs.planner.push(input);
    return plannerResult ?? { runId: 'planner-run', output: 'PLAN:\n1. scaffold | build\n2. review | verify\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/scaffold.js', () => ({
  scaffold: vi.fn(async (input: string) => {
    calls.push('scaffold');
    inputs.scaffold.push(input);
    return { runId: 'scaffold-run', output: 'created', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/test.js', () => ({
  test: vi.fn(async (input: string) => {
    calls.push('test');
    inputs.test.push(input);
    return { runId: 'test-run', output: '[TESTS: PASS]', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/review/index.js', () => ({
  review: vi.fn(async (input: string) => {
    calls.push('review');
    inputs.review.push(input);
    return { runId: 'review-run', output: '[VERDICT: SHIP]', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/cicd.js', () => ({
  cicd: vi.fn(async (input: string) => {
    calls.push('cicd');
    inputs.cicd.push(input);
    return { runId: 'cicd-run', output: 'ci', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('./post-success-commit.js', () => ({
  commitSuccessfulSpec,
}));


const { loadProjectConfig, runVerifyStep, snapshotWorkspace, emitRunEvent, executeTeam } = vi.hoisted(() => ({
  loadProjectConfig: vi.fn((): any => undefined),
  runVerifyStep: vi.fn(async (_opts: any): Promise<any> => ({ runId: 'verify-run', passed: true, outcome: { exitCode: 0, timedOut: false, cancelled: false, durationMs: 5, outputTail: '' } })),
  snapshotWorkspace: vi.fn(async (_dir: string): Promise<any> => new Map()),
  emitRunEvent: vi.fn((_runId: string, _event: any) => {}),
  executeTeam: vi.fn(async (_plan: any, _opts: any): Promise<any> => ({ tasks: [], failed: false })),
}));

const { runRuntimeVerification } = vi.hoisted(() => ({
  runRuntimeVerification: vi.fn(async (): Promise<any> => ({
    runId: 'runtime-verify-run',
    passed: true,
    cancelled: false,
    blocked: false,
    output: 'runtime verified',
    feedback: '',
    evidenceSummary: '- healthcheck: PASS (HTTP 200)',
    records: [{ stage: 'healthcheck', status: 'PASS' }],
  })),
}));
const { projectFindingKey, recordOperationalFinding } = vi.hoisted(() => ({
  projectFindingKey: vi.fn(() => 'demo'),
  recordOperationalFinding: vi.fn(),
}));

vi.mock('../lib/run-events.js', () => ({ emitRunEvent, closeEmitter: vi.fn(), getOrCreateEmitter: vi.fn() }));
vi.mock('../lib/review-findings.js', () => ({ projectFindingKey, recordOperationalFinding }));

vi.mock('../lib/project-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/project-config.js')>()),
  loadProjectConfig,
}));

vi.mock('../lib/role-boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/role-boundary.js')>()),
  snapshotWorkspace,
}));

vi.mock('./verify-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./verify-gate.js')>()),
  runVerifyStep,
}));

vi.mock('./runtime-gate.js', () => ({ runRuntimeVerification }));

vi.mock('./team.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./team.js')>()),
  executeTeam,
}));

import { runSpec, workflowOutput, workflowRunStatus } from './spec.js';

beforeEach(() => {
  projectFindingKey.mockReturnValue('demo');
  recordOperationalFinding.mockClear();
});

describe('runSpec clarification gate', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(inputs) as Array<keyof typeof inputs>) inputs[key].length = 0;
    clarifierResult = undefined;
    clarifierQueue = [];
    plannerResult = undefined;
    loadProjectConfig.mockReturnValue(undefined);
    executeTeam.mockReset();
    executeTeam.mockImplementation(async (_plan: any, _opts: any): Promise<any> => ({ tasks: [], failed: false }));
    runVerifyStep.mockReset();
    runVerifyStep.mockImplementation(async (_opts: any): Promise<any> => ({ runId: 'verify-run', passed: true, outcome: verifyOutcome() }));
    commitSuccessfulSpec.mockClear();
    runRuntimeVerification.mockReset();
    runRuntimeVerification.mockImplementation(async () => ({
      runId: 'runtime-verify-run',
      passed: true,
      cancelled: false,
      blocked: false,
      output: 'runtime verified',
      feedback: '',
      evidenceSummary: '- healthcheck: PASS (HTTP 200)',
      records: [{ stage: 'healthcheck', status: 'PASS' }],
    }));
  });

  it('stops before planning and implementation when clarifier says requirements are not ready', async () => {
    const result = await runSpec('사용자 관리 기능 구현');

    expect(calls).toEqual(['clarifier']);
    expect(result.verdict).toBe('NEEDS-CLARIFICATION');
    expect(result.clarification?.questions).toHaveLength(1);
    expect(result.steps).toEqual({
      clarifier: { runId: 'clarifier-run', durationMs: 10, status: 'NEEDS-CLARIFICATION' },
    });
    expect(commitSuccessfulSpec).not.toHaveBeenCalled();
  });

  it('blocks the workflow when clarifier output is not parseable JSON', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: '질문이 남아 있습니다. JSON 형식이 아닙니다.',
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };

    const result = await runSpec('명확하지 않은 요청');

    expect(calls).toEqual(['clarifier']);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.steps).toEqual({
      clarifier: { runId: 'clarifier-run', durationMs: 10, status: 'BLOCKED' },
    });
  });

  it('stops the workflow when the active agent is cancelled', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: '[cancelled] 사용자 요청으로 실행을 중단했습니다.',
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 10,
      status: 'CANCELLED',
    };

    const result = await runSpec('취소할 요청');

    expect(calls).toEqual(['clarifier']);
    expect(result.verdict).toBe('CANCELLED');
    expect(result.steps.clarifier.status).toBe('CANCELLED');
    expect(workflowRunStatus(result)).toBe('FAILED');
  });

  it('accepts clarifier JSON wrapped in markdown fences', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: '```json\n' + JSON.stringify({
        ready: false,
        summary: '',
        questions: [
          {
            id: 'q1',
            category: 'scope',
            text: '어떤 범위까지 구현할까요?',
            recommendation: '핵심 CRUD만 포함합니다.',
          },
        ],
      }) + '\n```',
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };

    const result = await runSpec('명확하지 않은 요청');

    expect(result.verdict).toBe('NEEDS-CLARIFICATION');
    expect(result.clarification?.questions).toHaveLength(1);
    expect(result.steps.clarifier.status).toBe('NEEDS-CLARIFICATION');
  });

  it('records BLOCKED child status and stops the workflow', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'Rate limit in effect.',
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      status: 'BLOCKED',
    };

    const result = await runSpec('명확한 요청');

    expect(calls).toEqual(['clarifier', 'planner']);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.steps.planner).toEqual({ runId: 'planner-run', durationMs: 0, status: 'BLOCKED' });
    expect(result.failure).toEqual({
      step: 'planner',
      status: 'BLOCKED',
      cause: 'agent_stopped',
      reason: 'Rate limit in effect.',
      routeAvailable: false,
    });
    expect(workflowOutput(result)).toContain('failure reason:\nRate limit in effect.');
    expect(result.steps.scaffold).toBeUndefined();
  });

  it('accepts a single-step plan for a narrowly scoped request', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. review | verify the narrowly scoped change\nEND.',
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };

    const result = await runSpec('좁은 범위의 요청', {
      steps: new Set(['clarifier', 'planner', 'review']),
    });

    expect(result.verdict).toBe('SHIP');
    expect(result.steps.planner.status).toBe('DONE');
    expect(result.steps.review.status).toBe('DONE');
    expect(commitSuccessfulSpec).toHaveBeenCalledOnce();
  });

  it('does not schedule post-success commits for eval workflows', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. review | verify the narrowly scoped change\nEND.',
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 10,
      status: 'DONE',
    };

    const result = await runSpec('좁은 범위의 요청', {
      steps: new Set(['clarifier', 'planner', 'review']),
      triggerSource: 'eval',
    });

    expect(result.verdict).toBe('SHIP');
    expect(commitSuccessfulSpec).not.toHaveBeenCalled();
  });

  it('includes the review output when a requested planner route cannot be taken', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = { runId: 'planner-run', output: 'PLAN:\n1. scaffold | fix contract\n2. review | verify contract\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
    const { review } = await import('../agents/review/index.js');
    (review as any).mockResolvedValueOnce({
      runId: 'review-run',
      output: 'Hello from review!\nFinding: broken contract\n[VERDICT: NEEDS-WORK]\n[ROUTE: planner]',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청', { steps: new Set(['clarifier', 'planner', 'review']), maxRoutes: 0 });

    expect(result.verdict).toBe('NEEDS-WORK');
    expect(result.failure?.step).toBe('review');
    expect(result.failure?.route).toBe('planner');
    expect(result.failure?.routeAvailable).toBe(false);
    expect(result.failure?.cause).toBe('route_limit_exhausted');
    expect(result.failure?.reason).toContain('Rework route budget exhausted (0/0)');
    expect(workflowOutput(result)).toContain('Finding: broken contract');
    expect(workflowOutput(result)).toContain('failure cause: route_limit_exhausted');
  });

  it('allows more than two productive review repair routes by default', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = { runId: 'planner-run', output: 'PLAN:\n1. scaffold | fix findings\n2. review | verify findings\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
    const { review } = await import('../agents/review/index.js');
    for (let attempt = 1; attempt <= 3; attempt++) {
      (review as any).mockResolvedValueOnce({
        runId: `review-run-${attempt}`,
        output: `Finding ${attempt}\n[ROUTE: planner]\n[VERDICT: NEEDS-WORK]`,
        tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
      });
    }

    const result = await runSpec('명확한 요청', { steps: new Set(['clarifier', 'planner', 'review']) });

    expect(result.verdict).toBe('SHIP');
    expect(result.routeCount).toBe(3);
    expect(result.failure).toBeUndefined();
    expect(calls.filter(step => step === 'planner')).toHaveLength(4);
  });

  it('defaults a markerless review rework response to planner', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = { runId: 'planner-run', output: 'PLAN:\n1. scaffold | fix regression\n2. review | verify regression\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
    const { review } = await import('../agents/review/index.js');
    (review as any).mockResolvedValueOnce({
      runId: 'review-run-needs-work',
      output: 'Review found a high-impact regression that requires code changes.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청', {
      steps: new Set(['clarifier', 'planner', 'review']),
      maxRoutes: 1,
    });

    expect(result.verdict).toBe('SHIP');
    expect(result.routeCount).toBe(1);
    expect(calls.filter(step => step === 'planner')).toHaveLength(2);
    expect(inputs.planner[1]).toContain('Review found a high-impact regression');
  });

  it('stops on an unroutable test failure instead of continuing to review', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = { runId: 'planner-run', output: 'PLAN:\n1. scaffold | fix production bug\n2. test | verify production bug\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
    const { test } = await import('../agents/test.js');
    (test as any).mockResolvedValueOnce({
      runId: 'test-run-fail',
      output: 'Production bug\n[TESTS: FAIL]\n[ROUTE: planner]',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청', {
      steps: new Set(['clarifier', 'planner', 'test', 'review']),
      maxRoutes: 0,
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failure?.step).toBe('test');
    expect(result.failure?.cause).toBe('route_limit_exhausted');
    expect(calls).not.toContain('review');
  });

  it('defaults a markerless test failure route to planner', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = { runId: 'planner-run', output: 'PLAN:\n1. scaffold | fix production bug\n2. test | verify production bug\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
    const { test } = await import('../agents/test.js');
    (test as any).mockResolvedValueOnce({
      runId: 'test-run-fail',
      output: 'Production bug\n[TESTS: FAIL]',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청', {
      steps: new Set(['clarifier', 'planner', 'test']),
      maxRoutes: 1,
    });

    expect(result.verdict).toBeUndefined();
    expect(result.routeCount).toBe(1);
    expect(calls.filter(step => step === 'planner')).toHaveLength(2);
  });

  it('returns the planner output text as planOutput', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };

    const result = await runSpec('명확한 요청', { steps: new Set(['clarifier', 'planner']) });

    expect(result.planOutput).toBe('PLAN:\n1. scaffold | build\n2. review | verify\nEND.');
  });

  it('blocks invalid planner output without replacing the last valid plan', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'Your organization has disabled Claude subscription access for Claude Code',
      tokensIn: 0, tokensOut: 0, durationMs: 10, status: 'DONE',
    };
    const previousPlan = 'PLAN:\n1. scaffold | keep valid plan\n2. review | verify valid plan\nEND.';

    const result = await runSpec('명확한 요청', {
      steps: new Set(['planner', 'scaffold']),
      startStep: 'planner',
      initialPlanOutput: previousPlan,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.failure).toMatchObject({ step: 'planner', cause: 'invalid_output' });
    expect(result.steps.planner.status).toBe('BLOCKED');
    expect(result.planOutput).toBe(previousPlan);
    expect(calls).toEqual(['planner']);
  });

  it('blocks markerless test output instead of continuing to review', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    const { test } = await import('../agents/test.js');
    (test as any).mockResolvedValueOnce({
      runId: 'test-run-invalid', output: 'Tests look fine.', tokensIn: 1, tokensOut: 1,
      durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청', {
      steps: new Set(['clarifier', 'planner', 'test', 'review']),
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.failure).toMatchObject({ step: 'test', cause: 'invalid_output' });
    expect(result.steps.test.status).toBe('BLOCKED');
    expect(calls).not.toContain('review');
  });

  it('skips cicd when the planner did not assign a CI/CD task', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | implement app code\n2. test | verify it\nEND.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };

    const result = await runSpec('애플리케이션 기능 구현');

    expect(calls).not.toContain('cicd');
    expect(result.steps.cicd).toBeUndefined();
    expect(commitSuccessfulSpec).toHaveBeenCalledOnce();
    expect(commitSuccessfulSpec).toHaveBeenCalledWith(expect.objectContaining({
      specContent: '애플리케이션 기능 구현',
      clarifiedSpec: '명확한 스펙',
    }));
  });

  it('keeps the spec successful when background post-success processing fails', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    commitSuccessfulSpec.mockResolvedValueOnce({
      steps: {
        'checking-docs-before-commit': { runId: 'docs-run', durationMs: 4, status: 'BLOCKED' },
      },
      failure: {
        step: 'checking-docs-before-commit',
        status: 'BLOCKED',
        cause: 'invalid_output',
        reason: 'docs were not ready',
      },
    });

    const result = await runSpec('애플리케이션 기능 구현');

    expect(result.verdict).toBe('SHIP');
    expect(result.failure).toBeUndefined();
    expect(workflowRunStatus(result)).toBe('DONE');
  });

  it('passes only the assigned cicd task instead of the whole planner output', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | implement app code\n2. cicd | add CI workflow\nEND.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };

    await runSpec('애플리케이션 기능 및 CI 설정');

    expect(inputs.cicd[0]).toContain('cicd | add CI workflow');
    expect(inputs.cicd[0]).not.toContain('scaffold | implement app code');
    expect(inputs.cicd[0]).toContain('deliveryIntent: ci');
  });

  it('prepends initial feedback only to the first executed step', async () => {
    const result = await runSpec('명확한 요청', {
      steps: new Set(['review', 'cicd']),
      startStep: 'review',
      initialFeedback: '리뷰 지적을 반영해 수정하라',
    });

    expect(result.verdict).toBe('SHIP');
    expect(calls).toEqual(['review', 'cicd']);
    expect(inputs.review[0]).toContain('리뷰 지적을 반영해 수정하라');
    expect(inputs.cicd[0]).not.toContain('리뷰 지적을 반영해 수정하라');
    expect(inputs.cicd[0]).toContain('deliveryIntent: ci');
  });

  it('passes explicit deployment intent through to cicd', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };

    await runSpec('명확한 요청', {
      steps: new Set(['review', 'cicd']),
      startStep: 'review',
      deliveryIntent: 'cd',
    });

    expect(inputs.cicd[0]).toContain('deliveryIntent: cd');
  });
});

// clarifier 응답을 만드는 헬퍼. questions 가 있으면 ready:false(질문), 없으면 ready:true.
function clarifierOut(questions: Array<{ id: string; recommendation: string }> | null) {
  return {
    runId: 'clarifier-run',
    output: JSON.stringify({
      ready: questions === null,
      summary: questions === null ? '명확한 스펙' : '',
      questions: (questions ?? []).map((q) => ({
        id: q.id, category: 'scope', text: `${q.id}?`, recommendation: q.recommendation,
      })),
    }),
    tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
  };
}

describe('runSpec auto-clarify (skip mode)', () => {
  beforeEach(() => {
    calls.length = 0;
    clarifierResult = undefined;
    clarifierQueue = [];
    plannerResult = undefined;
  });

  it('auto-answers with recommendations and proceeds past the gate when ready', async () => {
    // 1회차: 질문 → 자동 답변, 2회차: ready → 통과
    clarifierQueue = [
      clarifierOut([{ id: 'q1', recommendation: '핵심 CRUD만' }]),
      clarifierOut(null),
    ];

    const result = await runSpec('사용자 관리 기능', { autoClarify: true });

    expect(result.verdict).not.toBe('NEEDS-CLARIFICATION');
    expect(calls.filter((c) => c === 'clarifier')).toHaveLength(2);
    expect(calls).toContain('planner');
    expect(result.autoClarifyRounds).toHaveLength(1);
    expect(result.autoClarifyRounds?.[0].answers).toEqual({ q1: '핵심 CRUD만' });
  });

  it('feeds the auto answers back into the next clarifier round', async () => {
    clarifierQueue = [
      clarifierOut([{ id: 'q1', recommendation: '핵심 CRUD만' }]),
      clarifierOut(null),
    ];
    const { clarifier } = await import('../agents/clarifier.js');
    (clarifier as any).mockClear(); // 이전 테스트의 호출 이력 제거

    await runSpec('사용자 관리 기능', { autoClarify: true });

    // 두 번째 clarifier 호출 입력에 1회차 추천 답안이 Q&A 로 실려야 한다.
    const secondInput = (clarifier as any).mock.calls[1][0] as string;
    expect(secondInput).toContain('q1');
    expect(secondInput).toContain('핵심 CRUD만');
  });

  it('has no auto-clarify round limit by default', async () => {
    clarifierQueue = [
      clarifierOut([{ id: 'q1', recommendation: 'a1' }]),
      clarifierOut([{ id: 'q2', recommendation: 'a2' }]),
      clarifierOut([{ id: 'q3', recommendation: 'a3' }]),
      clarifierOut([{ id: 'q4', recommendation: 'a4' }]),
      clarifierOut(null),
    ];

    const result = await runSpec('모호한 요청', { autoClarify: true });

    expect(calls.filter((c) => c === 'clarifier')).toHaveLength(5);
    expect(result.autoClarifyRounds).toHaveLength(4);
    expect(calls).toContain('planner');
  });

  it('stops with NEEDS-CLARIFICATION after hitting the round cap', async () => {
    // 항상 질문만 반환 → 상한(2) 만큼 자동 답변 후 멈춤
    clarifierResult = clarifierOut([{ id: 'q1', recommendation: '추천' }]);

    const result = await runSpec('모호한 요청', { autoClarify: true, maxClarifyRounds: 2 });

    expect(result.verdict).toBe('NEEDS-CLARIFICATION');
    expect(result.autoClarifyRounds).toHaveLength(2);
    // 상한 도달 시 최종 질문을 사용자에게 넘긴다.
    expect(result.clarification?.questions).toHaveLength(1);
    expect(calls.filter((c) => c === 'clarifier')).toHaveLength(3); // 2회 자동 + 상한 후 1회
  });

  it('leaves the gate untouched when autoClarify is off (default)', async () => {
    clarifierResult = clarifierOut([{ id: 'q1', recommendation: '추천' }]);

    const result = await runSpec('모호한 요청');

    expect(result.verdict).toBe('NEEDS-CLARIFICATION');
    expect(result.autoClarifyRounds).toBeUndefined();
    expect(calls).toEqual(['clarifier']);
  });
});

// ── Phase 1: 결정적 검증 게이트 ────────────────────────────────────
const READY_CLARIFIER = {
  runId: 'clarifier-run',
  output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
  tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
};
const PLAN_WITH_TEST = {
  runId: 'planner-run',
  output: 'PLAN:\n1. scaffold | build\n2. test | verify\n3. review | check\nEND.',
  tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
};

function verifyOutcome(overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, timedOut: false, cancelled: false, durationMs: 5, outputTail: '', ...overrides };
}

function failingVerify(outputTail = 'FooTest > bar FAILED') {
  return { runId: 'verify-run', passed: false, outcome: verifyOutcome({ exitCode: 1, outputTail }) };
}

describe('runSpec verification gate', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(inputs) as Array<keyof typeof inputs>) inputs[key].length = 0;
    clarifierResult = READY_CLARIFIER;
    clarifierQueue = [];
    plannerResult = PLAN_WITH_TEST;
    commitSuccessfulSpec.mockClear();
    runRuntimeVerification.mockClear();
    loadProjectConfig.mockReturnValue({ version: 1, verify: { command: './gradlew check', timeoutMs: 1000 } });
    runVerifyStep.mockClear();
    runVerifyStep.mockResolvedValue({ runId: 'verify-run', passed: true, outcome: verifyOutcome() });
    emitRunEvent.mockClear();
    snapshotWorkspace.mockClear();
  });

  afterEach(() => {
    loadProjectConfig.mockReturnValue(undefined);
  });

  it('proceeds to review when the verify command exits 0', async () => {
    const result = await runSpec('명확한 요청');

    expect(runVerifyStep).toHaveBeenCalledOnce();
    expect(runVerifyStep.mock.calls[0][0]).toMatchObject({ verify: { command: './gradlew check' } });
    expect(calls).toContain('review');
    expect(result.verdict).toBe('SHIP');
    expect(result.steps.verify).toEqual({ runId: 'verify-run', durationMs: 5, status: 'DONE' });
  });

  it('ignores a PASS marker and routes to planner when the verify command fails', async () => {
    runVerifyStep.mockResolvedValueOnce(failingVerify());

    const result = await runSpec('명확한 요청', { maxRoutes: 1 });

    expect(result.routeCount).toBe(1);
    expect(calls.filter((step) => step === 'planner')).toHaveLength(2);
    expect(inputs.planner[1]).toContain('FooTest > bar FAILED');
    expect(inputs.planner[1]).toContain('./gradlew check');
    expect(result.verdict).toBe('SHIP');
    // 재라우팅하면 이전 시도의 verify 결과는 결과 맵에 남지 않는다.
    expect(result.steps.verify.status).toBe('DONE');
  });

  it('fails with verify_failed once the route budget is exhausted', async () => {
    runVerifyStep.mockResolvedValue(failingVerify('exit code 1'));

    const result = await runSpec('명확한 요청', { maxRoutes: 0 });

    expect(result.verdict).toBe('FAILED');
    expect(result.failure).toMatchObject({ step: 'verify', cause: 'verify_failed', route: 'planner', routeAvailable: false });
    expect(recordOperationalFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'verify', project: 'demo', ruleHint: 'verify command failed: ./gradlew check',
    }));
    expect(calls).not.toContain('review');
    expect(commitSuccessfulSpec).not.toHaveBeenCalled();
  });

  it('does not run verify when the test agent reports FAIL', async () => {
    const { test } = await import('../agents/test.js');
    (test as any).mockResolvedValueOnce({
      runId: 'test-run-fail', output: 'Production bug\n[TESTS: FAIL]',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    await runSpec('명확한 요청', { maxRoutes: 0 });

    expect(runVerifyStep).not.toHaveBeenCalled();
  });

  it('does not run verify when the test agent is BLOCKED', async () => {
    const { test } = await import('../agents/test.js');
    (test as any).mockResolvedValueOnce({
      runId: 'test-run-blocked', output: 'runner missing\n[TESTS: BLOCKED]',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    });

    const result = await runSpec('명확한 요청');

    expect(runVerifyStep).not.toHaveBeenCalled();
    expect(result.verdict).toBe('BLOCKED');
  });

  it('keeps the legacy flow and warns when the project declares no verify command', async () => {
    loadProjectConfig.mockReturnValue(undefined);

    const result = await runSpec('명확한 요청');

    expect(runVerifyStep).not.toHaveBeenCalled();
    expect(emitRunEvent).toHaveBeenCalledWith('test-run', expect.objectContaining({ type: 'warn', data: 'verify_not_configured' }));
    expect(result.verdict).toBe('SHIP');
  });

  it('stops as CANCELLED instead of spending a repair route when verify is cancelled', async () => {
    runVerifyStep.mockResolvedValue({
      runId: 'verify-run',
      passed: false,
      outcome: verifyOutcome({ exitCode: null, cancelled: true }),
    });

    const result = await runSpec('명확한 요청', { maxRoutes: 4 });

    expect(result.verdict).toBe('CANCELLED');
    expect(result.routeCount).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(calls).not.toContain('review');
  });

  it('tells scaffold and test which command decides the verdict', async () => {
    await runSpec('명확한 요청');

    expect(inputs.scaffold[0]).toContain('./gradlew check');
    expect(inputs.test[0]).toContain('./gradlew check');
    expect(inputs.planner[0]).not.toContain('## 검증 명령');
  });

  it('reruns the fixed REPRO command before the configured verify command and review', async () => {
    const reproCommand = 'npm test -- --run src/widget.test.ts';

    const result = await runSpec('버그 수정', { reproCommand });

    expect(runVerifyStep).toHaveBeenCalledTimes(2);
    expect(runVerifyStep.mock.calls[0][0]).toMatchObject({
      verify: { command: reproCommand },
      expectedOutcome: 'pass',
      triggerDetail: 'bug-reproduction-confirmation',
    });
    expect(runVerifyStep.mock.calls[1][0]).toMatchObject({ verify: { command: './gradlew check' } });
    expect(inputs.scaffold[0]).toContain(reproCommand);
    expect(inputs.test[0]).toContain(reproCommand);
    expect(result.steps.repro).toMatchObject({ status: 'DONE' });
    expect(calls.indexOf('test')).toBeLessThan(calls.indexOf('review'));
    expect(result.verdict).toBe('SHIP');
  });

  it('fails with reproduction_failed when the fixed REPRO command still fails and no routes remain', async () => {
    runVerifyStep.mockResolvedValueOnce(failingVerify('repro still fails'));

    const result = await runSpec('버그 수정', { reproCommand: './repro.sh', maxRoutes: 0 });

    expect(result.verdict).toBe('FAILED');
    expect(result.failure).toMatchObject({ step: 'repro', cause: 'reproduction_failed' });
    expect(result.failure?.reason).toContain('repro still fails');
    expect(calls).not.toContain('review');
    expect(runVerifyStep).toHaveBeenCalledOnce();
  });

  it('uses the sequential gates instead of the dynamic team plan in bug mode', async () => {
    plannerResult = {
      ...plannerResult!,
      output: 'PLAN:\n1. scaffold | fix\n2. test | rerun repro\n3. review | inspect\nEND.\nTEAM_PLAN:\n' +
        JSON.stringify({ version: 1, tasks: [{ id: 'impl', agent: 'scaffold', input: 'fix', writes: true }] }) + '\nEND_TEAM_PLAN.',
    };

    await runSpec('버그 수정', { reproCommand: './repro.sh' });

    expect(executeTeam).not.toHaveBeenCalled();
    expect(runVerifyStep.mock.calls[0][0]).toMatchObject({ verify: { command: './repro.sh' } });
  });

  it('gates the dynamic team path after integration', async () => {
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | build\n2. review | check\nEND.\nTEAM_PLAN:\n' +
        JSON.stringify({ version: 1, tasks: [{ id: 'impl', agent: 'scaffold', input: 'build', writes: true }] }) +
        '\nEND_TEAM_PLAN.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    executeTeam.mockResolvedValueOnce({
      tasks: [{ taskId: 'rev', agent: 'review', status: 'DONE', output: '[VERDICT: SHIP]' }],
      failed: false,
    });
    runVerifyStep.mockResolvedValueOnce(failingVerify('integration broke the build'));

    const result = await runSpec('명확한 요청');

    expect(runVerifyStep).toHaveBeenCalledOnce();
    expect(result.verdict).toBe('FAILED');
    expect(result.failure).toMatchObject({ step: 'verify', cause: 'verify_failed' });
    expect(result.failure?.reason).toContain('integration broke the build');
    expect(commitSuccessfulSpec).not.toHaveBeenCalled();
  });

  it('runs runtime verification before review and sends its evidence to review', async () => {
    loadProjectConfig.mockReturnValue({
      version: 1,
      runtime: {
        up: 'up', down: 'down', healthcheck: { url: 'http://localhost/health', timeoutMs: 1000 }, checks: [],
      },
    });

    const result = await runSpec('명확한 요청');

    expect(result.verdict).toBe('SHIP');
    expect(runRuntimeVerification).toHaveBeenCalledOnce();
    expect(calls.indexOf('test')).toBeLessThan(calls.indexOf('review'));
    expect(inputs.review[0]).toContain('검증 증거 요약');
    expect(inputs.review[0]).toContain('healthcheck: PASS');
  });

  it('routes runtime verification failure back to planner with observed evidence', async () => {
    loadProjectConfig.mockReturnValue({
      version: 1,
      runtime: {
        up: 'up', down: 'down', healthcheck: { url: 'http://localhost/health', timeoutMs: 1000 }, checks: [],
      },
    });
    runRuntimeVerification
      .mockResolvedValueOnce({
        runId: 'runtime-verify-fail', passed: false, cancelled: false, blocked: false,
        output: 'runtime failed', feedback: 'HTTP 500 observed', evidenceSummary: '- healthcheck: FAIL (HTTP 500)',
        records: [{ stage: 'healthcheck', status: 'FAIL' }],
      } as any)
      .mockResolvedValueOnce({
        runId: 'runtime-verify-pass', passed: true, cancelled: false, blocked: false,
        output: 'runtime passed', feedback: '', evidenceSummary: '- healthcheck: PASS (HTTP 200)',
        records: [{ stage: 'healthcheck', status: 'PASS' }],
      } as any);

    const result = await runSpec('명확한 요청', { maxRoutes: 2 });

    expect(result.verdict).toBe('SHIP');
    expect(result.routeCount).toBe(1);
    expect(inputs.planner[1]).toContain('HTTP 500 observed');
    expect(calls.filter(step => step === 'planner')).toHaveLength(2);
  });

  it('defers dynamic-team review until after runtime verification and includes evidence', async () => {
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | build\n2. review | check\nEND.\nTEAM_PLAN:\n' +
        JSON.stringify({ version: 1, tasks: [{ id: 'impl', agent: 'scaffold', input: 'build', writes: true }] }) +
        '\nEND_TEAM_PLAN.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    executeTeam.mockResolvedValueOnce({
      tasks: [{ taskId: 'impl', agent: 'scaffold', status: 'DONE', output: 'implemented' }],
      deferredReviews: [{ id: 'review', agent: 'review', input: '검토', dependsOn: ['impl'] }],
      failed: false,
    });
    loadProjectConfig.mockReturnValue({
      version: 1,
      runtime: {
        up: 'up', down: 'down', healthcheck: { url: 'http://localhost/health', timeoutMs: 1000 }, checks: [],
      },
    });

    const result = await runSpec('명확한 요청');

    expect(result.verdict).toBe('SHIP');
    expect(executeTeam).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deferReview: true }));
    expect(runRuntimeVerification).toHaveBeenCalledOnce();
    expect(inputs.review[0]).toContain('healthcheck: PASS');
  });

  it('keeps the existing dynamic-team execution when no project gates are configured', async () => {
    loadProjectConfig.mockReturnValue(undefined);
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | build\n2. review | check\nEND.\nTEAM_PLAN:\n' +
        JSON.stringify({ version: 1, tasks: [{ id: 'impl', agent: 'scaffold', input: 'build', writes: true }] }) +
        '\nEND_TEAM_PLAN.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    executeTeam.mockResolvedValueOnce({
      tasks: [
        { taskId: 'impl', agent: 'scaffold', status: 'DONE', output: 'implemented' },
        { taskId: 'review', agent: 'review', status: 'DONE', output: '[VERDICT: SHIP]' },
      ],
      failed: false,
    });

    const result = await runSpec('명확한 요청');

    expect(result.verdict).toBe('SHIP');
    expect(executeTeam).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deferReview: false }));
    expect(runRuntimeVerification).not.toHaveBeenCalled();
    expect(inputs.review).toHaveLength(0);
  });

  it('does not run dynamic-team review when runtime verification fails', async () => {
    plannerResult = {
      runId: 'planner-run',
      output: 'PLAN:\n1. scaffold | build\n2. review | check\nEND.\nTEAM_PLAN:\n' +
        JSON.stringify({ version: 1, tasks: [{ id: 'impl', agent: 'scaffold', input: 'build', writes: true }] }) +
        '\nEND_TEAM_PLAN.',
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };
    executeTeam.mockResolvedValueOnce({
      tasks: [{ taskId: 'impl', agent: 'scaffold', status: 'DONE', output: 'implemented' }],
      deferredReviews: [{ id: 'review', agent: 'review', input: '검토', dependsOn: ['impl'] }],
      failed: false,
    });
    loadProjectConfig.mockReturnValue({
      version: 1,
      runtime: {
        up: 'up', down: 'down', healthcheck: { url: 'http://localhost/health', timeoutMs: 1000 }, checks: [],
      },
    });
    runRuntimeVerification.mockResolvedValueOnce({
      runId: 'runtime-verify-fail', passed: false, cancelled: false, blocked: false,
      output: 'runtime failed', feedback: 'HTTP 500 observed', evidenceSummary: '- healthcheck: FAIL (HTTP 500)',
      records: [{ stage: 'healthcheck', status: 'FAIL' }],
    } as any);

    const result = await runSpec('명확한 요청', { maxRoutes: 0 });

    expect(result.verdict).toBe('FAILED');
    expect(result.failure).toMatchObject({ step: 'verify', cause: 'verify_failed' });
    expect(calls).not.toContain('review');
    expect(inputs.review).toHaveLength(0);
  });

  it('fails immediately when the runtime verifier changes a source file', async () => {
    loadProjectConfig.mockReturnValue({
      version: 1,
      runtime: {
        up: 'up', down: 'down', healthcheck: { url: 'http://localhost/health', timeoutMs: 1000 }, checks: [],
      },
    });
    runRuntimeVerification.mockResolvedValueOnce({
      runId: 'runtime-verify-edit', passed: false, cancelled: false, blocked: false,
      output: 'workspace changed', feedback: 'verifier modified src/main.ts', evidenceSummary: '',
      records: [{ stage: 'verifier', status: 'FAIL', changedFiles: ['src/main.ts'] }],
    } as any);

    const result = await runSpec('명확한 요청');

    expect(result.failure).toMatchObject({ step: 'verify', cause: 'role_boundary_violation' });
    expect(result.failure?.reason).toContain('src/main.ts');
    expect(calls).not.toContain('review');
    expect(recordOperationalFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'role-boundary', file: 'src/main.ts', project: 'demo',
    }));
  });
});

describe('runSpec role boundary check', () => {
  const BOUNDARY_CONFIG = {
    version: 1 as const,
    roleBoundary: { testGlobs: ['**/*.test.ts'], ignoreGlobs: [] },
  };

  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(inputs) as Array<keyof typeof inputs>) inputs[key].length = 0;
    clarifierResult = READY_CLARIFIER;
    clarifierQueue = [];
    plannerResult = PLAN_WITH_TEST;
    commitSuccessfulSpec.mockClear();
    loadProjectConfig.mockReturnValue(BOUNDARY_CONFIG);
    runVerifyStep.mockClear();
    emitRunEvent.mockClear();
    snapshotWorkspace.mockClear();
    snapshotWorkspace.mockResolvedValue(new Map());
  });

  afterEach(() => {
    loadProjectConfig.mockReturnValue(undefined);
    snapshotWorkspace.mockResolvedValue(new Map());
  });

  it('fails the workflow when the test step edits a production file', async () => {
    snapshotWorkspace
      .mockResolvedValueOnce(new Map([['src/lib/a.ts', 'hash-1']]))
      .mockResolvedValueOnce(new Map([['src/lib/a.ts', 'hash-2']]));

    const result = await runSpec('명확한 요청');

    expect(result.verdict).toBe('FAILED');
    expect(result.failure).toMatchObject({ step: 'test', cause: 'role_boundary_violation' });
    expect(result.failure?.reason).toContain('src/lib/a.ts');
    expect(result.steps.test.status).toBe('FAILED');
    expect(calls).not.toContain('review');
    expect(commitSuccessfulSpec).not.toHaveBeenCalled();
    expect(recordOperationalFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'role-boundary', file: 'src/lib/a.ts', project: 'demo',
    }));
  });

  it('allows the test step to create and edit test files', async () => {
    snapshotWorkspace
      .mockResolvedValueOnce(new Map([['src/lib/a.ts', 'hash-1']]))
      .mockResolvedValueOnce(new Map([['src/lib/a.ts', 'hash-1'], ['src/lib/a.test.ts', 'hash-new']]));

    const result = await runSpec('명확한 요청');

    expect(result.failure).toBeUndefined();
    expect(result.verdict).toBe('SHIP');
  });

  it('skips the check with a warning when the workspace is not a git repository', async () => {
    snapshotWorkspace.mockResolvedValueOnce(undefined);

    const result = await runSpec('명확한 요청');

    expect(emitRunEvent).toHaveBeenCalledWith('test-run', expect.objectContaining({ type: 'warn' }));
    expect(emitRunEvent.mock.calls.some((call) => String(call[1].data).startsWith('role_boundary_skipped'))).toBe(true);
    expect(result.verdict).toBe('SHIP');
  });

  it('does not snapshot the workspace when no test globs are declared', async () => {
    loadProjectConfig.mockReturnValue({ version: 1 });

    await runSpec('명확한 요청');

    expect(snapshotWorkspace).not.toHaveBeenCalled();
  });
});
