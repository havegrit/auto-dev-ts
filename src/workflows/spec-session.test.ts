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

import { startSpecSession, resumeSpecSession, pendingClarification } from './spec-session.js';

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
    expect(saveClarificationState).not.toHaveBeenCalled();
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
