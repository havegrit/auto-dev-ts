import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    return plannerResult ?? { runId: 'planner-run', output: 'PLAN:\n1. scaffold | build\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
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

import { runSpec } from './spec.js';

describe('runSpec clarification gate', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(inputs) as Array<keyof typeof inputs>) inputs[key].length = 0;
    clarifierResult = undefined;
    clarifierQueue = [];
    plannerResult = undefined;
  });

  it('stops before planning and implementation when clarifier says requirements are not ready', async () => {
    const result = await runSpec('사용자 관리 기능 구현');

    expect(calls).toEqual(['clarifier']);
    expect(result.verdict).toBe('NEEDS-CLARIFICATION');
    expect(result.clarification?.questions).toHaveLength(1);
    expect(result.steps).toEqual({
      clarifier: { runId: 'clarifier-run', durationMs: 10, status: 'NEEDS-CLARIFICATION' },
    });
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
    expect(result.steps.scaffold).toBeUndefined();
  });

  it('returns the planner output text as planOutput', async () => {
    clarifierResult = {
      runId: 'clarifier-run',
      output: JSON.stringify({ ready: true, summary: '명확한 스펙', questions: [] }),
      tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE',
    };

    const result = await runSpec('명확한 요청', { steps: new Set(['clarifier', 'planner']) });

    expect(result.planOutput).toBe('PLAN:\n1. scaffold | build\nEND.');
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
