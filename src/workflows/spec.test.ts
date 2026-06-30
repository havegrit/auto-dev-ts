import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
let clarifierResult: any;
let plannerResult: any;

vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock('../agents/clarifier.js', () => ({
  clarifier: vi.fn(async () => {
    calls.push('clarifier');
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
  planner: vi.fn(async () => {
    calls.push('planner');
    return plannerResult ?? { runId: 'planner-run', output: 'PLAN:\n1. scaffold | build\nEND.', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/scaffold.js', () => ({
  scaffold: vi.fn(async () => {
    calls.push('scaffold');
    return { runId: 'scaffold-run', output: 'created', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/test.js', () => ({
  test: vi.fn(async () => {
    calls.push('test');
    return { runId: 'test-run', output: '[TESTS: PASS]', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/review/index.js', () => ({
  review: vi.fn(async () => {
    calls.push('review');
    return { runId: 'review-run', output: '[VERDICT: SHIP]', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

vi.mock('../agents/cicd.js', () => ({
  cicd: vi.fn(async () => {
    calls.push('cicd');
    return { runId: 'cicd-run', output: 'ci', tokensIn: 1, tokensOut: 1, durationMs: 10, status: 'DONE' };
  }),
}));

import { runSpec } from './spec.js';

describe('runSpec clarification gate', () => {
  beforeEach(() => {
    calls.length = 0;
    clarifierResult = undefined;
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
});
