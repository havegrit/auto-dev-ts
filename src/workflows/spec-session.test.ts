import { describe, it, expect, vi, beforeEach } from 'vitest';

const specInputs: string[] = [];
const specOptions: any[] = [];
let specResult: any;

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
vi.mock('../store/runs.js', () => ({
  insertRun: vi.fn((row: any) => inserted.push(row)),
  updateRun: vi.fn((id: string, patch: any) => updates.push({ id, ...patch })),
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

const writes: Array<{ path: string; content: string }> = [];
vi.mock('fs', () => ({
  writeFileSync: vi.fn((path: string, content: string) => writes.push({ path, content })),
  mkdirSync: vi.fn(),
}));

import { startSpecSession, resumeSpecSession, continueSpecSession, resumeLastSpecStep, pendingClarification, specRunPlan } from './spec-session.js';

const Q1 = { id: 'q1', category: 'scope', text: '범위는?', recommendation: '핵심 CRUD' };

beforeEach(() => {
  specInputs.length = 0;
  specOptions.length = 0;
  inserted.length = 0;
  updates.length = 0;
  writes.length = 0;
  childRuns = [];
  stateStore.clear();
  saveClarificationState.mockClear();
  getClarificationState.mockClear();
  emitRunEvent.mockClear();
  closeEmitter.mockClear();
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
    expect(emitRunEvent).toHaveBeenCalledWith(runId, expect.objectContaining({ type: 'status', data: 'DONE' }));
    expect(closeEmitter).toHaveBeenCalledWith(runId);
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
    expect(specOptions[0].workflowRunId).toBe(runId);
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
