import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimAutoMergeRequest,
  finishAutoMergeRequestClaim,
  getAutoMergeRequestClaim,
  getAutoMergeRequestHistory,
  getAutoMergeDryRuns,
  getAutoMergeLiveTrustStreak,
  recordAutoMergeAction,
  recordAutoMergeDryRun,
  recordAutoMergeLiveObservation,
} from './auto-merge.js';

let database: InstanceType<typeof Database>;

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_run (id TEXT PRIMARY KEY);
    INSERT INTO agent_run (id) VALUES ('workflow-1');
    CREATE TABLE auto_merge_dry_run (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, repository TEXT NOT NULL,
      pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, base_branch TEXT NOT NULL,
      category TEXT NOT NULL, policy_fingerprint TEXT NOT NULL,
      eval_pass_count INTEGER NOT NULL, eval_distinct_case_count INTEGER NOT NULL,
      live_pass_count INTEGER NOT NULL, eligible INTEGER NOT NULL,
      reasons_json TEXT NOT NULL, checked_at TEXT NOT NULL
    );
    CREATE TABLE auto_merge_live_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repository TEXT NOT NULL, base_branch TEXT NOT NULL, pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL, category TEXT NOT NULL, policy_fingerprint TEXT NOT NULL,
      outcome TEXT NOT NULL, merged_by TEXT NOT NULL, approved_by TEXT NOT NULL, evidence_source TEXT NOT NULL,
      merged_at TEXT NOT NULL, stability_verified_at TEXT, recorded_at TEXT NOT NULL,
      UNIQUE(repository, base_branch, pr_number, head_sha)
    );
    CREATE TABLE auto_merge_action (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, repository TEXT NOT NULL, pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, category TEXT NOT NULL, policy_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE auto_merge_request_claim (
      repository TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(repository, pr_number, head_sha)
    );
  `);
});

afterEach(() => database.close());

const now = new Date('2026-10-16T00:00:00.000Z');
const mergedAt = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
const sha = (index: number) => index.toString(16).padStart(40, '0');

function stableObservation(index: number, overrides: Record<string, unknown> = {}) {
  const merged = mergedAt(30 + index);
  return {
    repository: 'org/project',
    baseBranch: 'main',
    prNumber: index + 1,
    headSha: sha(index + 1),
    category: 'docs' as const,
    policyFingerprint: 'policy-a',
    outcome: 'stable' as const,
    mergedBy: 'human-owner',
    approvedBy: 'human-reviewer',
    evidenceSource: 'github-label:auto-dev/merge-stable by human-reviewer',
    mergedAt: merged,
    stabilityVerifiedAt: new Date(Date.parse(merged) + 14 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('auto-merge records', () => {
  it('persists an auditable dry-run result', () => {
    recordAutoMergeDryRun({
      workflowRunId: 'workflow-1',
      repository: 'org/project',
      prNumber: 42,
      headSha: sha(2),
      baseSha: sha(1),
      baseBranch: 'main',
      category: 'docs',
      policyFingerprint: 'policy-a',
      evalPassCount: 20,
      evalDistinctCaseCount: 10,
      livePassCount: 0,
      eligible: false,
      reasons: ['live trust is insufficient'],
    }, database, now);

    expect(getAutoMergeDryRuns('workflow-1', database)[0]).toMatchObject({
      workflowRunId: 'workflow-1',
      prNumber: 42,
      category: 'docs',
      eligible: false,
      reasons: ['live trust is insufficient'],
    });
  });

  it('stores append-only action events and claims each PR head once', () => {
    const action = {
      workflowRunId: 'workflow-1', repository: 'org/project', prNumber: 42,
      headSha: sha(2), baseSha: sha(1), category: 'docs' as const,
      policyFingerprint: 'policy-a', status: 'pending' as const, actor: 'auto-dev',
      reason: 'Submitting GitHub auto-merge request.',
    };
    recordAutoMergeAction(action, database, now);
    recordAutoMergeAction({ ...action, status: 'requested', reason: 'GitHub accepted.', createdAt: '2026-10-16T00:00:01.000Z' }, database, now);
    expect(getAutoMergeRequestHistory('org/project', 42, sha(2), database).map(row => row.status)).toEqual(['requested', 'pending']);

    const claim = { repository: 'org/project', prNumber: 42, headSha: sha(2), workflowRunId: 'workflow-1' };
    expect(claimAutoMergeRequest(claim, database, now)).toBe(true);
    expect(claimAutoMergeRequest({ ...claim, workflowRunId: 'workflow-2' }, database, now)).toBe(false);
    expect(getAutoMergeRequestClaim('org/project', 42, sha(2), database)?.state).toBe('claimed');
    finishAutoMergeRequestClaim('org/project', 42, sha(2), 'requested', database, now);
    expect(getAutoMergeRequestClaim('org/project', 42, sha(2), database)).toMatchObject({
      workflowRunId: 'workflow-1', state: 'requested',
    });
  });

  it('requires 10 human-reviewed PRs stable for 14 days under the same policy fingerprint', () => {
    for (let index = 0; index < 10; index++) recordAutoMergeLiveObservation(stableObservation(index), database, now);
    expect(getAutoMergeLiveTrustStreak('org/project', 'main', 'docs', 'policy-a', database, now)).toMatchObject({
      passedCount: 10,
      requiredCount: 10,
      qualifies: true,
    });
  });

  it('resets on failures, fingerprint changes, and observations before day 14', () => {
    for (let index = 0; index < 9; index++) recordAutoMergeLiveObservation(stableObservation(index), database, now);
    recordAutoMergeLiveObservation(stableObservation(9, {
      outcome: 'reverted',
      mergedAt: mergedAt(1),
      stabilityVerifiedAt: undefined,
    }), database, now);
    expect(getAutoMergeLiveTrustStreak('org/project', 'main', 'docs', 'policy-a', database, now).passedCount).toBe(0);

    recordAutoMergeLiveObservation(stableObservation(9), database, now);
    expect(getAutoMergeLiveTrustStreak('org/project', 'main', 'docs', 'policy-b', database, now).passedCount).toBe(0);

    expect(() => recordAutoMergeLiveObservation(stableObservation(10, {
      mergedAt: mergedAt(5),
      stabilityVerifiedAt: mergedAt(1),
    }), database, now)).toThrow(/after 14 full days/);

    expect(() => recordAutoMergeLiveObservation(stableObservation(10, {
      mergedBy: 'merge-bot[bot]',
    }), database, now)).toThrow(/human merger/);
  });
});
