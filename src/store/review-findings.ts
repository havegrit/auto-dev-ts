import { randomUUID } from 'node:crypto';
import { db } from './db.js';

export interface ReviewFindingInsert {
  id?: string;
  runId: string;
  workflowRunId: string;
  project: string;
  severity: string;
  category: string;
  ruleHint: string;
  file?: string;
  createdAt?: string;
}

export interface ReviewFindingCandidate {
  project: string;
  category: string;
  rule_hint: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_file?: string;
}

export function insertReviewFindings(findings: ReviewFindingInsert[]): void {
  if (findings.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO review_finding
      (id, run_id, workflow_run_id, project, severity, category, rule_hint, file, created_at)
    VALUES
      (@id, @runId, @workflowRunId, @project, @severity, @category, @ruleHint, @file, @createdAt)
  `);
  db.transaction((rows: ReviewFindingInsert[]) => {
    for (const row of rows) {
      insert.run({
        id: row.id ?? randomUUID(),
        runId: row.runId,
        workflowRunId: row.workflowRunId,
        project: row.project,
        severity: row.severity,
        category: row.category,
        ruleHint: row.ruleHint,
        file: row.file ?? null,
        createdAt: row.createdAt ?? new Date().toISOString(),
      });
    }
  }).immediate(findings);
}

/** 프로젝트별 최근 14일 반복 지적을 빈도순으로 반환한다. */
export function getReviewFindingCandidates(
  project?: string,
  limitPerProject = 5,
): ReviewFindingCandidate[] {
  const limit = Math.max(1, Math.min(20, Math.trunc(limitPerProject) || 5));
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    WITH grouped AS (
      SELECT project, category, rule_hint,
             COUNT(*) AS count,
             MIN(created_at) AS first_seen,
             MAX(created_at) AS last_seen,
             MIN(NULLIF(file, '')) AS sample_file
      FROM review_finding
      WHERE created_at >= @since
        AND (@project IS NULL OR project = @project)
      GROUP BY project, category, rule_hint
    ), ranked AS (
      SELECT grouped.*,
             ROW_NUMBER() OVER (
               PARTITION BY project
               ORDER BY count DESC, last_seen DESC, category ASC, rule_hint ASC
             ) AS rank
      FROM grouped
    )
    SELECT project, category, rule_hint, count, first_seen, last_seen, sample_file
    FROM ranked
    WHERE rank <= @limit
    ORDER BY project ASC, count DESC, last_seen DESC, category ASC, rule_hint ASC
  `).all({ since, project: project ?? null, limit }) as ReviewFindingCandidate[];
}
