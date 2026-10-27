import { db as defaultDb } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';

export type IssueExecutionStatus = 'RUNNING' | 'DELIVERY_PENDING' | 'STATE_UPDATE_PENDING' | 'DONE' | 'HUMAN_REVIEW' | 'FAILED';
export type IssueExecutionSource = 'poll' | 'api' | 'cli';

export interface IssueExecution {
  id: string;
  issue_key: string;
  provider_issue_id?: string;
  trigger_source: IssueExecutionSource;
  status: IssueExecutionStatus;
  lease_token?: string;
  lease_expires_at?: string;
  heartbeat_at?: string;
  source_dir: string;
  worktree_path?: string;
  remote?: string;
  branch_name?: string;
  base_branch?: string;
  base_sha?: string;
  commit_sha?: string;
  target_status?: string;
  attempt_count: number;
  retry_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface IssueExecutionCreateInput {
  id: string;
  issueKey: string;
  providerIssueId?: string;
  source: IssueExecutionSource;
  leaseToken: string;
  sourceDir: string;
  maxConcurrency: number;
  leaseSeconds?: number;
}

export type IssueExecutionPatch = Partial<Pick<IssueExecution,
  'status' | 'worktree_path' | 'remote' | 'branch_name' | 'base_branch' | 'base_sha' |
  'commit_sha' | 'target_status' | 'retry_at' | 'last_error' | 'attempt_count' | 'completed_at'>>;

export type IssueExecutionAcquireResult =
  | { acquired: true; execution: IssueExecution }
  | { acquired: false; reason: 'duplicate' | 'capacity'; active?: IssueExecution };

export function tryAcquireIssueExecution(
  input: IssueExecutionCreateInput,
  database: DatabaseType = defaultDb,
  now = new Date(),
): IssueExecutionAcquireResult {
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseSeconds ?? 90) * 1_000).toISOString();
  const acquire = database.transaction((): IssueExecutionAcquireResult => {
    const duplicate = database.prepare(`
      SELECT * FROM issue_execution
      WHERE issue_key = ? AND status IN ('RUNNING','DELIVERY_PENDING','STATE_UPDATE_PENDING')
      ORDER BY created_at DESC LIMIT 1
    `).get(input.issueKey) as IssueExecution | undefined;
    if (duplicate) {
      // Even expired leases remain locked until the scheduler records human review and preserves the worktree.
      return { acquired: false, reason: 'duplicate', active: duplicate };
    }

    const activeCount = (database.prepare(`
      SELECT COUNT(*) AS count FROM issue_execution WHERE status IN ('RUNNING','DELIVERY_PENDING','STATE_UPDATE_PENDING')
    `).get() as { count: number }).count;
    if (activeCount >= input.maxConcurrency) return { acquired: false, reason: 'capacity' };

    database.prepare(`
      INSERT INTO issue_execution (
        id, issue_key, provider_issue_id, trigger_source, status, lease_token,
        lease_expires_at, heartbeat_at, source_dir, attempt_count, created_at, updated_at
      ) VALUES (
        @id, @issueKey, @providerIssueId, @source, 'RUNNING', @leaseToken,
        @leaseExpiresAt, @now, @sourceDir, 0, @now, @now
      )
    `).run({
      id: input.id,
      issueKey: input.issueKey,
      providerIssueId: input.providerIssueId ?? null,
      source: input.source,
      leaseToken: input.leaseToken,
      leaseExpiresAt,
      sourceDir: input.sourceDir,
      now: nowIso,
    });
    const execution = database.prepare('SELECT * FROM issue_execution WHERE id = ?').get(input.id) as IssueExecution;
    return { acquired: true, execution };
  });
  return acquire.immediate();
}

export function heartbeatIssueExecution(
  id: string,
  leaseToken: string,
  leaseSeconds = 90,
  database: DatabaseType = defaultDb,
  now = new Date(),
): boolean {
  const nowIso = now.toISOString();
  const result = database.prepare(`
    UPDATE issue_execution
    SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'RUNNING'
  `).run(nowIso, new Date(now.getTime() + leaseSeconds * 1_000).toISOString(), nowIso, id, leaseToken);
  return result.changes > 0;
}

export function updateIssueExecution(
  id: string,
  patch: IssueExecutionPatch,
  database: DatabaseType = defaultDb,
  now = new Date(),
): void {
  const columns: Array<[keyof IssueExecutionPatch, string]> = [
    ['status', 'status'], ['worktree_path', 'worktree_path'], ['remote', 'remote'],
    ['branch_name', 'branch_name'], ['base_branch', 'base_branch'], ['base_sha', 'base_sha'],
    ['commit_sha', 'commit_sha'], ['target_status', 'target_status'], ['retry_at', 'retry_at'],
    ['last_error', 'last_error'], ['attempt_count', 'attempt_count'], ['completed_at', 'completed_at'],
  ];
  const values = columns.filter(([property]) => patch[property] !== undefined);
  if (values.length === 0) return;
  const sets = values.map(([, column]) => `${column} = @${column}`);
  sets.push('updated_at = @updated_at');
  const parameters: Record<string, unknown> = { id, updated_at: now.toISOString() };
  for (const [property, column] of values) parameters[column] = patch[property];
  database.prepare(`UPDATE issue_execution SET ${sets.join(', ')} WHERE id = @id`).run(parameters);
}

export function finishIssueExecution(
  id: string,
  status: Extract<IssueExecutionStatus, 'DONE' | 'HUMAN_REVIEW' | 'FAILED'>,
  options: { error?: string; commitSha?: string } = {},
  database: DatabaseType = defaultDb,
  now = new Date(),
): void {
  const nowIso = now.toISOString();
  database.prepare(`
    UPDATE issue_execution
    SET status = ?, commit_sha = COALESCE(?, commit_sha), last_error = ?,
        lease_token = NULL, lease_expires_at = NULL, retry_at = NULL,
        completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, options.commitSha ?? null, options.error ?? null, nowIso, nowIso, id);
}

export function listRecoverableIssueExecutions(database: DatabaseType = defaultDb): IssueExecution[] {
  return database.prepare(`
    SELECT * FROM issue_execution
    WHERE status IN ('RUNNING','DELIVERY_PENDING','STATE_UPDATE_PENDING')
    ORDER BY created_at ASC
  `).all() as IssueExecution[];
}

export function listDueIssueDeliveries(
  database: DatabaseType = defaultDb,
  now = new Date(),
): IssueExecution[] {
  return database.prepare(`
    SELECT * FROM issue_execution
    WHERE status = 'DELIVERY_PENDING' AND (retry_at IS NULL OR retry_at <= ?)
    ORDER BY created_at ASC
  `).all(now.toISOString()) as IssueExecution[];
}

export function listDueIssueStateUpdates(
  database: DatabaseType = defaultDb,
  now = new Date(),
): IssueExecution[] {
  return database.prepare(`
    SELECT * FROM issue_execution
    WHERE status = 'STATE_UPDATE_PENDING' AND (retry_at IS NULL OR retry_at <= ?)
    ORDER BY created_at ASC
  `).all(now.toISOString()) as IssueExecution[];
}

export function expireStaleIssueExecutions(
  database: DatabaseType = defaultDb,
  now = new Date(),
): IssueExecution[] {
  const nowIso = now.toISOString();
  const stale = database.prepare(`
    SELECT * FROM issue_execution
    WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).all(nowIso) as IssueExecution[];
  if (stale.length === 0) return stale;
  const expire = database.prepare(`
    UPDATE issue_execution
    SET status = 'STATE_UPDATE_PENDING', target_status = 'HUMAN_REVIEW', last_error = ?, retry_at = ?,
        lease_token = NULL, lease_expires_at = NULL, completed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'RUNNING' AND lease_expires_at <= ?
  `);
  const transaction = database.transaction(() => {
    for (const execution of stale) {
      expire.run('Execution lease expired after process interruption; worktree retained for human review.', nowIso, nowIso, execution.id, nowIso);
    }
  });
  transaction.immediate();
  return stale;
}

export function getIssueExecution(id: string, database: DatabaseType = defaultDb): IssueExecution | undefined {
  return database.prepare('SELECT * FROM issue_execution WHERE id = ?').get(id) as IssueExecution | undefined;
}
