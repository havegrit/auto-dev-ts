import { randomUUID } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  AUTO_MERGE_LIVE_PR_STREAK_MIN,
  AUTO_MERGE_STABILITY_DAYS,
  type AutoMergeRiskCategory,
} from '../lib/auto-merge-policy.js';
import { db as appDb } from './db.js';

export interface AutoMergeDryRunRecord {
  workflowRunId: string;
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  category: AutoMergeRiskCategory | 'ineligible';
  policyFingerprint: string;
  evalPassCount: number;
  evalDistinctCaseCount: number;
  livePassCount: number;
  eligible: boolean;
  reasons: string[];
  checkedAt?: string;
}

export interface AutoMergeDryRunRow extends AutoMergeDryRunRecord {
  id: string;
  checkedAt: string;
}

export interface AutoMergeLiveObservation {
  repository: string;
  baseBranch: string;
  prNumber: number;
  headSha: string;
  category: AutoMergeRiskCategory;
  policyFingerprint: string;
  outcome: 'stable' | 'reverted' | 'hotfix' | 'rework' | 'unknown';
  mergedBy: string;
  approvedBy: string;
  evidenceSource: string;
  mergedAt: string;
  stabilityVerifiedAt?: string;
  recordedAt?: string;
}

export interface AutoMergeLiveTrustStreak {
  passedCount: number;
  requiredCount: number;
  qualifies: boolean;
  reason: string;
}

interface AutoMergeDryRunSqlRow {
  id: string;
  workflow_run_id: string;
  repository: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  base_branch: string;
  category: AutoMergeDryRunRecord['category'];
  policy_fingerprint: string;
  eval_pass_count: number;
  eval_distinct_case_count: number;
  live_pass_count: number;
  eligible: number;
  reasons_json: string;
  checked_at: string;
}

interface AutoMergeLiveSqlRow {
  policy_fingerprint: string;
  outcome: AutoMergeLiveObservation['outcome'];
  merged_at: string;
  stability_verified_at?: string;
  pr_number: number;
}

/** PR dry-run의 입력과 거부 이유를 감사 목적으로 저장한다. */
export function recordAutoMergeDryRun(
  record: AutoMergeDryRunRecord,
  database: DatabaseType = appDb,
  now = new Date(),
): AutoMergeDryRunRow {
  const checkedAt = record.checkedAt ?? now.toISOString();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO auto_merge_dry_run (
      id, workflow_run_id, repository, pr_number, head_sha, base_sha, base_branch, category,
      policy_fingerprint, eval_pass_count, eval_distinct_case_count, live_pass_count,
      eligible, reasons_json, checked_at
    ) VALUES (
      @id, @workflowRunId, @repository, @prNumber, @headSha, @baseSha, @baseBranch, @category,
      @policyFingerprint, @evalPassCount, @evalDistinctCaseCount, @livePassCount,
      @eligible, @reasonsJson, @checkedAt
    )
  `).run({
    id,
    workflowRunId: record.workflowRunId,
    repository: record.repository,
    prNumber: record.prNumber,
    headSha: record.headSha,
    baseSha: record.baseSha,
    baseBranch: record.baseBranch,
    category: record.category,
    policyFingerprint: record.policyFingerprint,
    evalPassCount: record.evalPassCount,
    evalDistinctCaseCount: record.evalDistinctCaseCount,
    livePassCount: record.livePassCount,
    eligible: record.eligible ? 1 : 0,
    reasonsJson: JSON.stringify(record.reasons),
    checkedAt,
  });
  return { ...record, id, checkedAt };
}

export function getAutoMergeDryRuns(
  workflowRunId: string,
  database: DatabaseType = appDb,
): AutoMergeDryRunRow[] {
  const rows = database.prepare(`
    SELECT * FROM auto_merge_dry_run WHERE workflow_run_id = ? ORDER BY checked_at DESC, id DESC
  `).all(workflowRunId) as AutoMergeDryRunSqlRow[];
  return rows.map(row => ({
    id: row.id,
    workflowRunId: row.workflow_run_id,
    repository: row.repository,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    baseBranch: row.base_branch,
    category: row.category,
    policyFingerprint: row.policy_fingerprint,
    evalPassCount: row.eval_pass_count,
    evalDistinctCaseCount: row.eval_distinct_case_count,
    livePassCount: row.live_pass_count,
    eligible: row.eligible === 1,
    reasons: JSON.parse(row.reasons_json) as string[],
    checkedAt: row.checked_at,
  }));
}

export function getAutoMergeKnownPullRequests(
  repository: string,
  baseBranch: string,
  database: DatabaseType = appDb,
): Array<Pick<AutoMergeDryRunRow, 'repository' | 'prNumber' | 'headSha' | 'baseSha' | 'baseBranch' | 'category' | 'policyFingerprint'>> {
  return database.prepare(`
    SELECT repository, pr_number, head_sha, base_sha, base_branch, category, policy_fingerprint
    FROM auto_merge_dry_run AS current
    WHERE repository = ? AND base_branch = ? AND category IN ('docs','dependency-patch')
      AND NOT EXISTS (
        SELECT 1 FROM auto_merge_dry_run AS newer
        WHERE newer.repository = current.repository
          AND newer.base_branch = current.base_branch
          AND newer.pr_number = current.pr_number
          AND (newer.checked_at > current.checked_at OR (newer.checked_at = current.checked_at AND newer.id > current.id))
      )
    ORDER BY checked_at DESC, id DESC
  `).all(repository, baseBranch).map((row) => {
    const value = row as {
      repository: string; pr_number: number; head_sha: string; base_sha: string;
      base_branch: string; category: AutoMergeRiskCategory; policy_fingerprint: string;
    };
    return {
      repository: value.repository,
      prNumber: value.pr_number,
      headSha: value.head_sha,
      baseSha: value.base_sha,
      baseBranch: value.base_branch,
      category: value.category,
      policyFingerprint: value.policy_fingerprint,
    };
  });
}

/** 사람의 승인과 14일 관찰 결과를 저장한다. 안정 표시는 관찰 기간이 지난 뒤에만 받는다. */
export function recordAutoMergeLiveObservation(
  observation: AutoMergeLiveObservation,
  database: DatabaseType = appDb,
  now = new Date(),
): void {
  const mergedAt = Date.parse(observation.mergedAt);
  const verifiedAt = observation.stabilityVerifiedAt ? Date.parse(observation.stabilityVerifiedAt) : undefined;
  if (!observation.repository.trim() || !observation.baseBranch.trim() || !Number.isSafeInteger(observation.prNumber) || observation.prNumber <= 0) {
    throw new Error('A live PR observation requires a repository, base branch, and positive PR number.');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(observation.headSha)) {
    throw new Error('A live PR observation requires a valid head SHA.');
  }
  if (!observation.mergedBy.trim() || !observation.approvedBy.trim() || !observation.evidenceSource.trim() || !Number.isFinite(mergedAt)) {
    throw new Error('A live PR observation requires its merger, human approver, evidence source, and merge time.');
  }
  if (observation.outcome === 'stable') {
    if (verifiedAt === undefined || !Number.isFinite(verifiedAt) ||
      verifiedAt < mergedAt + AUTO_MERGE_STABILITY_DAYS * 24 * 60 * 60 * 1000 || verifiedAt > now.getTime()) {
      throw new Error(`Stable PR observations require a human GitHub stability label after ${AUTO_MERGE_STABILITY_DAYS} full days.`);
    }
    if (observation.mergedBy.toLowerCase() === 'unverified' || observation.mergedBy.toLowerCase().endsWith('[bot]')) {
      throw new Error('Stable PR observations require a human merger.');
    }
    if (observation.approvedBy.toLowerCase() === 'unverified' || observation.approvedBy.toLowerCase().endsWith('[bot]')) {
      throw new Error('Stable PR observations require a human reviewer.');
    }
    if (!observation.evidenceSource.startsWith('github-label:auto-dev/merge-stable by ')) {
      throw new Error('Stable PR observations require a human GitHub stability label.');
    }
  }
  database.prepare(`
    INSERT INTO auto_merge_live_observation (
      repository, base_branch, pr_number, head_sha, category, policy_fingerprint, outcome,
      merged_by, approved_by, evidence_source, merged_at, stability_verified_at, recorded_at
    ) VALUES (
      @repository, @baseBranch, @prNumber, @headSha, @category, @policyFingerprint, @outcome,
      @mergedBy, @approvedBy, @evidenceSource, @mergedAt, @stabilityVerifiedAt, @recordedAt
    )
    ON CONFLICT(repository, base_branch, pr_number, head_sha) DO UPDATE SET
      category = excluded.category,
      policy_fingerprint = excluded.policy_fingerprint,
      outcome = excluded.outcome,
      merged_by = excluded.merged_by,
      approved_by = excluded.approved_by,
      evidence_source = excluded.evidence_source,
      merged_at = excluded.merged_at,
      stability_verified_at = excluded.stability_verified_at,
      recorded_at = excluded.recorded_at
  `).run({
    repository: observation.repository.trim(),
    baseBranch: observation.baseBranch.trim(),
    prNumber: observation.prNumber,
    headSha: observation.headSha,
    category: observation.category,
    policyFingerprint: observation.policyFingerprint,
    outcome: observation.outcome,
    mergedBy: observation.mergedBy.trim(),
    approvedBy: observation.approvedBy.trim(),
    evidenceSource: observation.evidenceSource.trim(),
    mergedAt: observation.mergedAt,
    stabilityVerifiedAt: observation.stabilityVerifiedAt ?? null,
    recordedAt: observation.recordedAt ?? now.toISOString(),
  });
}

/** 최신 저위험 PR의 연속 안정 관찰을 계산한다. 확인할 수 없는 결과는 streak를 초기화한다. */
export function getAutoMergeLiveTrustStreak(
  repository: string,
  baseBranch: string,
  category: AutoMergeRiskCategory,
  fingerprint: string,
  database: DatabaseType = appDb,
  now = new Date(),
): AutoMergeLiveTrustStreak {
  const rows = database.prepare(`
    SELECT policy_fingerprint, outcome, merged_at, stability_verified_at, pr_number
    FROM (
      SELECT policy_fingerprint, outcome, merged_at, stability_verified_at, pr_number,
        ROW_NUMBER() OVER (PARTITION BY pr_number ORDER BY recorded_at DESC, id DESC) AS observation_order
      FROM auto_merge_live_observation
      WHERE repository = ? AND base_branch = ? AND category = ?
    )
    WHERE observation_order = 1
    ORDER BY merged_at ASC, pr_number ASC
  `).all(repository, baseBranch, category) as AutoMergeLiveSqlRow[];
  let streak = 0;
  for (const row of rows) {
    const mergedAt = Date.parse(row.merged_at);
    const stabilityVerifiedAt = row.stability_verified_at ? Date.parse(row.stability_verified_at) : Number.NaN;
    const stableLongEnough = Number.isFinite(mergedAt) && Number.isFinite(stabilityVerifiedAt) &&
      stabilityVerifiedAt >= mergedAt + AUTO_MERGE_STABILITY_DAYS * 24 * 60 * 60 * 1000 &&
      stabilityVerifiedAt <= now.getTime();
    if (row.policy_fingerprint !== fingerprint || row.outcome !== 'stable' || !stableLongEnough) {
      streak = 0;
    } else {
      streak++;
    }
  }
  const qualifies = streak >= AUTO_MERGE_LIVE_PR_STREAK_MIN;
  return {
    passedCount: streak,
    requiredCount: AUTO_MERGE_LIVE_PR_STREAK_MIN,
    qualifies,
    reason: qualifies
      ? `Live PR history qualifies (${streak} consecutive human-reviewed PRs stable for ${AUTO_MERGE_STABILITY_DAYS} days).`
      : `Live trust requires ${AUTO_MERGE_LIVE_PR_STREAK_MIN} consecutive human-reviewed PRs stable for ${AUTO_MERGE_STABILITY_DAYS} days; found ${streak}.`,
  };
}
