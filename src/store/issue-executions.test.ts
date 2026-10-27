import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { expireStaleIssueExecutions, listDueIssueDeliveries, listDueIssueStateUpdates, tryAcquireIssueExecution, updateIssueExecution } from './issue-executions.js';

function makeDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE issue_execution (
      id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, provider_issue_id TEXT, trigger_source TEXT NOT NULL,
      status TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT, heartbeat_at TEXT, source_dir TEXT NOT NULL,
      worktree_path TEXT, remote TEXT, branch_name TEXT, base_branch TEXT, base_sha TEXT, commit_sha TEXT,
      target_status TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, retry_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE UNIQUE INDEX active_issue_key ON issue_execution(issue_key) WHERE status IN ('RUNNING','DELIVERY_PENDING','STATE_UPDATE_PENDING');
  `);
  return database;
}

describe('issue execution leases', () => {
  const databases: DatabaseType[] = [];
  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it('deduplicates poll and direct API triggers and enforces the shared concurrency limit', () => {
    const database = makeDb();
    databases.push(database);
    const now = new Date('2026-10-27T00:00:00.000Z');
    const first = tryAcquireIssueExecution({
      id: 'run-1', issueKey: 'AD-1', source: 'poll', leaseToken: 'lease-1', sourceDir: '/repo', maxConcurrency: 2,
    }, database, now);
    const duplicate = tryAcquireIssueExecution({
      id: 'run-2', issueKey: 'AD-1', source: 'api', leaseToken: 'lease-2', sourceDir: '/repo', maxConcurrency: 2,
    }, database, now);
    const second = tryAcquireIssueExecution({
      id: 'run-3', issueKey: 'AD-2', source: 'api', leaseToken: 'lease-3', sourceDir: '/repo', maxConcurrency: 2,
    }, database, now);
    const overCapacity = tryAcquireIssueExecution({
      id: 'run-4', issueKey: 'AD-3', source: 'poll', leaseToken: 'lease-4', sourceDir: '/repo', maxConcurrency: 2,
    }, database, now);

    expect(first.acquired).toBe(true);
    expect(duplicate).toMatchObject({ acquired: false, reason: 'duplicate' });
    expect(second.acquired).toBe(true);
    expect(overCapacity).toMatchObject({ acquired: false, reason: 'capacity' });
  });

  it('expires stale leases and exposes only due Git deliveries', () => {
    const database = makeDb();
    databases.push(database);
    const now = new Date('2026-10-27T00:00:00.000Z');
    tryAcquireIssueExecution({
      id: 'stale', issueKey: 'AD-1', source: 'poll', leaseToken: 'lease', sourceDir: '/repo', maxConcurrency: 2, leaseSeconds: 1,
    }, database, now);
    tryAcquireIssueExecution({
      id: 'pending', issueKey: 'AD-2', source: 'api', leaseToken: 'lease-2', sourceDir: '/repo', maxConcurrency: 2,
    }, database, now);
    updateIssueExecution('pending', { status: 'DELIVERY_PENDING', retry_at: new Date(now.getTime() + 60_000).toISOString() }, database, now);

    expect(expireStaleIssueExecutions(database, new Date(now.getTime() + 2_000))).toHaveLength(1);
    expect(listDueIssueStateUpdates(database, new Date(now.getTime() + 2_000))).toMatchObject([
      { id: 'stale', status: 'STATE_UPDATE_PENDING', target_status: 'HUMAN_REVIEW' },
    ]);
    expect(listDueIssueDeliveries(database, now)).toHaveLength(0);
    expect(listDueIssueDeliveries(database, new Date(now.getTime() + 61_000))).toMatchObject([
      { id: 'pending', status: 'DELIVERY_PENDING' },
    ]);
  });
});
