import { afterEach, describe, expect, it, vi } from 'vitest';

const { emitRunEvent, insertReviewFindings } = vi.hoisted(() => ({
  emitRunEvent: vi.fn(),
  insertReviewFindings: vi.fn(),
}));

vi.mock('./run-events.js', () => ({ emitRunEvent }));
vi.mock('../store/review-findings.js', () => ({ insertReviewFindings }));

import { captureReviewFindings, formatReviewFindingCandidates, parseReviewFindings, recordOperationalFinding } from './review-findings.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('parseReviewFindings', () => {
  it('parses the JSON block before the existing verdict markers', () => {
    const findings = parseReviewFindings([
      '리뷰 결과',
      'FINDINGS_JSON:',
      '[{"severity":"HIGH","category":"Layering","rule_hint":"controller에서 repository 직접 호출 금지","file":"src/controller.ts"}]',
      'END_FINDINGS.',
      '[VERDICT: NEEDS-WORK]',
      '[ROUTE: planner]',
    ].join('\n'));

    expect(findings).toEqual([{
      severity: 'high',
      category: 'layering',
      rule_hint: 'controller에서 repository 직접 호출 금지',
      file: 'src/controller.ts',
    }]);
  });

  it('accepts an empty findings array', () => {
    expect(parseReviewFindings('FINDINGS_JSON:\n[]\nEND_FINDINGS.\n[VERDICT: SHIP]')).toEqual([]);
  });

  it.each([
    ['missing block', '[VERDICT: SHIP]'],
    ['invalid JSON', 'FINDINGS_JSON:\n{bad}\nEND_FINDINGS.'],
    ['unsupported severity', 'FINDINGS_JSON:\n[{"severity":"critical","category":"x","rule_hint":"y"}]\nEND_FINDINGS.'],
    ['missing rule hint', 'FINDINGS_JSON:\n[{"severity":"high","category":"x"}]\nEND_FINDINGS.'],
  ])('rejects %s without partial results', (_label, output) => {
    expect(() => parseReviewFindings(output)).toThrow();
  });
});

describe('captureReviewFindings', () => {
  it('stores parsed findings with workflow and project identity', () => {
    const count = captureReviewFindings(
      'FINDINGS_JSON:\n[{"severity":"medium","category":"style","rule_hint":"avoid implicit any","file":"src/a.ts"}]\nEND_FINDINGS.',
      'review-1',
      'workflow-1',
      'demo',
    );

    expect(count).toBe(1);
    expect(insertReviewFindings).toHaveBeenCalledWith([{
      runId: 'review-1',
      workflowRunId: 'workflow-1',
      project: 'demo',
      severity: 'medium',
      category: 'style',
      ruleHint: 'avoid implicit any',
      file: 'src/a.ts',
    }]);
    expect(emitRunEvent).not.toHaveBeenCalled();
  });

  it('records a warning and keeps the workflow usable when parsing fails', () => {
    expect(captureReviewFindings('[VERDICT: SHIP]', 'review-2', 'workflow-2', 'demo')).toBe(0);
    expect(insertReviewFindings).not.toHaveBeenCalled();
    expect(emitRunEvent).toHaveBeenCalledWith('review-2', expect.objectContaining({
      type: 'warn',
      data: expect.stringContaining('review_findings_parse_failed'),
    }));
  });

  it('records a warning and returns normally when findings storage fails', () => {
    insertReviewFindings.mockImplementationOnce(() => { throw new Error('database unavailable'); });

    expect(captureReviewFindings(
      'FINDINGS_JSON:\n[{"severity":"high","category":"security","rule_hint":"validate input"}]\nEND_FINDINGS.',
      'review-3',
      'workflow-3',
      'demo',
    )).toBe(0);
    expect(emitRunEvent).toHaveBeenCalledWith('review-3', expect.objectContaining({
      type: 'warn',
      data: expect.stringContaining('review_findings_store_failed'),
    }));
  });

  it('stores orchestrator findings without changing workflow results', () => {
    expect(() => recordOperationalFinding({
      runId: 'verify-1', workflowRunId: 'workflow-1', project: 'demo', severity: 'high',
      category: 'verify', ruleHint: 'verify command failed: npm test',
    })).not.toThrow();
    expect(insertReviewFindings).toHaveBeenCalledWith([expect.objectContaining({
      runId: 'verify-1', category: 'verify', ruleHint: 'verify command failed: npm test',
    })]);
  });

  it('formats candidates grouped by project for daily briefing', () => {
    expect(formatReviewFindingCandidates([{
      project: 'demo', category: 'layering', rule_hint: 'no repository in controller',
      count: 3, first_seen: 'first', last_seen: 'last', sample_file: 'src/controller.ts',
    }])).toContain('### demo\n- [layering] no repository in controller (3회, 예: src/controller.ts)');
    expect(formatReviewFindingCandidates([])).toContain('반복 지적 없음');
  });
});
