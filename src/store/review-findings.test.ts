import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-findings-'));
  process.env.AUTO_DEV_DB_PATH = join(dir, 'test.db');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('review finding storage', () => {
  let insertReviewFindings: typeof import('./review-findings.js').insertReviewFindings;
  let getReviewFindingCandidates: typeof import('./review-findings.js').getReviewFindingCandidates;
  let db: typeof import('./db.js').db;

  beforeAll(async () => {
    ({ insertReviewFindings, getReviewFindingCandidates } = await import('./review-findings.js'));
    ({ db } = await import('./db.js'));
  });

  beforeEach(() => {
    db.exec('DELETE FROM review_finding');
  });

  it('ranks the top repeated rules per project over the latest 14 days', () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tooOld = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const rows = (project: string, ruleHint: string, count: number, createdAt = recent) =>
      Array.from({ length: count }, (_, index) => ({
        runId: `${project}-${ruleHint}-${index}`,
        workflowRunId: `${project}-workflow-${index}`,
        project,
        severity: 'high',
        category: 'layering',
        ruleHint,
        file: `src/${ruleHint}-${index}.ts`,
        createdAt,
      }));
    insertReviewFindings([
      ...rows('alpha', 'controller boundary', 4),
      ...rows('alpha', 'service transaction', 2),
      ...rows('alpha', 'old finding', 8, tooOld),
      ...rows('beta', 'controller boundary', 3),
    ]);

    const candidates = getReviewFindingCandidates(undefined, 1);

    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ project, rule_hint, count }) => ({ project, rule_hint, count }))).toEqual([
      { project: 'alpha', rule_hint: 'controller boundary', count: 4 },
      { project: 'beta', rule_hint: 'controller boundary', count: 3 },
    ]);
    expect(getReviewFindingCandidates('alpha', 5).map((row) => row.rule_hint)).toEqual([
      'controller boundary', 'service transaction',
    ]);
  });

  it('groups candidates by both category and rule hint', () => {
    insertReviewFindings([
      { runId: 'a', workflowRunId: 'w1', project: 'demo', severity: 'high', category: 'verify', ruleHint: 'npm test exits nonzero' },
      { runId: 'b', workflowRunId: 'w2', project: 'demo', severity: 'high', category: 'role-boundary', ruleHint: 'npm test exits nonzero' },
    ]);

    expect(getReviewFindingCandidates('demo')).toHaveLength(2);
  });
});
