import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_MERGE_EVAL_CASE_MIN,
  AUTO_MERGE_EVAL_STREAK_MIN,
  autoMergePolicyFingerprint,
  calculateEvalTrustStreak,
  classifyAutoMergeFiles,
  loadEvalTrustStreak,
} from './auto-merge-policy.js';

const fingerprint = 'policy-a';

describe('classifyAutoMergeFiles', () => {
  it.each([
    [['docs/guide.md', 'README.md'], 'docs'],
    [['CHANGELOG.md'], 'docs'],
    [['package.json', 'package-lock.json'], 'dependency-patch'],
    [['src/index.ts'], 'ineligible'],
    [['docs/guide.md', 'package.json'], 'ineligible'],
    [['.github/workflows/ci.yml'], 'ineligible'],
    [['../README.md'], 'ineligible'],
    [[], 'ineligible'],
  ])('classifies %j as %s', (files, expected) => {
    expect(classifyAutoMergeFiles(files as string[])).toBe(expected);
  });
});

describe('autoMergePolicyFingerprint', () => {
  it('is deterministic and changes with model or verification policy', () => {
    const config = { verify: { command: 'npm test', timeoutMs: 1000 } };
    const models = { scaffold: 'model-a', review: 'model-b' };
    const first = autoMergePolicyFingerprint(config, models);
    expect(autoMergePolicyFingerprint(config, models)).toBe(first);
    expect(autoMergePolicyFingerprint(config, { ...models, review: 'model-c' })).not.toBe(first);
    expect(autoMergePolicyFingerprint({ verify: { command: 'npm test', timeoutMs: 2000 } }, models)).not.toBe(first);
  });
});

describe('calculateEvalTrustStreak', () => {
  const results = Array.from({ length: AUTO_MERGE_EVAL_STREAK_MIN }, (_, index) => ({
    caseId: `case-${index % AUTO_MERGE_EVAL_CASE_MIN}`,
    category: 'docs' as const,
    policyFingerprint: fingerprint,
    pass: true,
    evaluatedAt: `2026-10-${String(Math.floor(index / 10) + 1).padStart(2, '0')}T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));

  it('requires twenty consecutive passes over ten distinct cases', () => {
    const streak = calculateEvalTrustStreak([{ results }], 'docs', fingerprint);
    expect(streak).toMatchObject({
      passedCount: 20,
      distinctCaseCount: 10,
      qualifies: true,
    });
  });

  it('resets on a failed, skipped, or different-fingerprint result', () => {
    for (const breaker of [
      { ...results[19], pass: false },
      { ...results[19], skipped: true },
      { ...results[19], policyFingerprint: 'policy-b' },
    ]) {
      const streak = calculateEvalTrustStreak([{ results: [...results.slice(0, 19), breaker] }], 'docs', fingerprint);
      expect(streak.qualifies).toBe(false);
      expect(streak.passedCount).toBe(0);
    }
  });

  it('ignores other risk categories and reports a short streak as unqualified', () => {
    const streak = calculateEvalTrustStreak([{
      results: [
        ...results.slice(0, 4),
        { ...results[4], category: 'dependency-patch' },
      ],
    }], 'docs', fingerprint);
    expect(streak).toMatchObject({ passedCount: 4, distinctCaseCount: 4, qualifies: false });
  });

  it('loads chronological eval artifacts and fails closed on corrupt history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autodev-eval-streak-'));
    try {
      writeFileSync(join(dir, '2026-10-16T00-00-00-000Z.json'), JSON.stringify({
        schemaVersion: 2,
        finishedAt: '2026-10-16T00:00:00.000Z',
        results: Array.from({ length: 20 }, (_, index) => ({
          caseId: `case-${index % 10}`,
          category: 'docs',
          policyFingerprint: fingerprint,
          pass: true,
        })),
      }));
      expect(loadEvalTrustStreak(dir, 'docs', fingerprint).qualifies).toBe(true);

      writeFileSync(join(dir, '2026-10-17T00-00-00-000Z.json'), '{broken');
      expect(loadEvalTrustStreak(dir, 'docs', fingerprint)).toMatchObject({ qualifies: false, passedCount: 0 });
      expect(loadEvalTrustStreak(dir, 'docs', fingerprint).reason).toMatch(/unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
