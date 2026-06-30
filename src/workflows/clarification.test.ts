import { describe, it, expect } from 'vitest';
import { planSlug, composeClarifierInput, renderPlanDoc } from './clarification.js';

describe('planSlug', () => {
  it('derives a filesystem-safe slug from the project name', () => {
    expect(planSlug('My Cool API', 'spec body')).toBe('my-cool-api');
  });

  it('falls back to the spec first heading when no project is given', () => {
    expect(planSlug(undefined, '# 사용자 인증\n본문')).toBe('사용자-인증');
  });

  it('falls back to spec-<id> when neither project nor heading is usable', () => {
    expect(planSlug(undefined, '   ')).toMatch(/^spec-[0-9a-f]{8}$/);
  });
});

describe('composeClarifierInput', () => {
  const spec = '사용자 관리 기능 구현';
  const round = {
    questions: [
      { id: 'q1', category: 'scope', text: '어떤 범위까지?', recommendation: '핵심 CRUD' },
      { id: 'q2', category: 'auth', text: '인증 방식은?', recommendation: 'JWT' },
    ],
    answers: { q1: 'CRUD + 검색', q2: 'JWT' },
  };

  it('returns the bare spec when there are no answered rounds', () => {
    expect(composeClarifierInput(spec, [])).toBe(spec);
  });

  it('appends a Q&A block with each answered question', () => {
    const out = composeClarifierInput(spec, [round]);
    expect(out.startsWith(spec)).toBe(true);
    expect(out).toContain('이전 Q&A');
    expect(out).toContain('q1 (scope): 어떤 범위까지? → 답: CRUD + 검색');
    expect(out).toContain('q2 (auth): 인증 방식은? → 답: JWT');
  });

  it('skips questions without an answer', () => {
    const out = composeClarifierInput(spec, [{ questions: round.questions, answers: { q1: 'CRUD만' } }]);
    expect(out).toContain('q1 (scope): 어떤 범위까지? → 답: CRUD만');
    expect(out).not.toContain('q2');
  });
});

describe('renderPlanDoc', () => {
  const now = new Date('2026-06-28T12:00:00Z');
  const base = {
    project: 'my-api',
    spec: '사용자 관리 기능 구현',
    rounds: [
      {
        questions: [{ id: 'q1', category: 'scope', text: '범위는?', recommendation: '핵심 CRUD' }],
        answers: { q1: 'CRUD + 검색' },
      },
    ],
    now,
  };

  it('includes the original spec and a decision-history entry per answered round', () => {
    const doc = renderPlanDoc(base);
    expect(doc).toContain('사용자 관리 기능 구현');
    expect(doc).toContain('의사결정');
    expect(doc).toContain('범위는?');
    expect(doc).toContain('CRUD + 검색');
  });

  it('includes the planner output as the plan section when provided', () => {
    const doc = renderPlanDoc({ ...base, planOutput: 'PLAN:\n1. scaffold | build\nEND.' });
    expect(doc).toContain('1. scaffold | build');
  });
});
