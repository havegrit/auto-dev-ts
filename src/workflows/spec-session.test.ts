import { describe, it, expect, vi, beforeEach } from 'vitest';

const specInputs: string[] = [];
let specResult: any;

vi.mock('./spec.js', () => ({
  runSpec: vi.fn(async (input: string) => {
    specInputs.push(input);
    return specResult;
  }),
}));

const inserted: any[] = [];
const updates: any[] = [];
vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn((row: any) => inserted.push(row)),
  updateRun: vi.fn((id: string, patch: any) => updates.push({ id, ...patch })),
}));

const stateStore = new Map<string, any>();
const saveClarificationState = vi.fn((id: string, state: any) => stateStore.set(id, state));
const getClarificationState = vi.fn((id: string) => stateStore.get(id));
vi.mock('../store/clarification.js', () => ({
  saveClarificationState: (id: string, s: any) => saveClarificationState(id, s),
  getClarificationState: (id: string) => getClarificationState(id),
}));

const writes: Array<{ path: string; content: string }> = [];
vi.mock('fs', () => ({
  writeFileSync: vi.fn((path: string, content: string) => writes.push({ path, content })),
  mkdirSync: vi.fn(),
}));

import { startSpecSession, resumeSpecSession, continueSpecSession, pendingClarification, specRunPlan } from './spec-session.js';

const Q1 = { id: 'q1', category: 'scope', text: '범위는?', recommendation: '핵심 CRUD' };

beforeEach(() => {
  specInputs.length = 0;
  inserted.length = 0;
  updates.length = 0;
  writes.length = 0;
  stateStore.clear();
  saveClarificationState.mockClear();
  getClarificationState.mockClear();
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
    expect(saved.spec).toBe('사용자 관리 기능');
    expect(saved.slug).toBe('my-api');
    expect(saved.planFile).toBe('docs/plan/my-api.md');
    expect(saved.cwd).toBe('/tmp/proj');
    expect(saved.rounds).toEqual([{ questions: [Q1] }]);

    const plan = writes.find(w => w.path === '/tmp/proj/docs/plan/my-api.md');
    expect(plan).toBeDefined();
    expect(plan!.content).toContain('사용자 관리 기능');
  });
});

describe('resumeSpecSession (round N)', () => {
  it('feeds spec + answers to the workflow and writes the plan with the planner output', async () => {
    stateStore.set('parent', {
      spec: '사용자 관리 기능',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
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
    expect(stateStore.get(runId).rounds.at(-1).answers).toEqual({ q1: 'CRUD + 검색' });
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

  it('rejects a blank instruction', () => {
    expect(() => continueSpecSession('parent', '   ')).toThrow(/instruction is required/);
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
