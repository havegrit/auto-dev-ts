import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  claimExpiredWorkflowCheckpoint,
  claimWorkflowDeliveryRetry,
  createWorkflowCheckpoint,
  finishWorkflowCheckpoint,
  getWorkflowCheckpoint,
  heartbeatWorkflowCheckpoint,
  listExpiredWorkflowCheckpoints,
  updateWorkflowCheckpoint,
} from './workflow-checkpoints.js';

const databases: Database.Database[] = [];

function createDb(): Database.Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_run (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, output TEXT,
      duration_ms INTEGER DEFAULT 0, error_type TEXT, stop_reason TEXT
    );
    CREATE TABLE workflow_checkpoint (
      workflow_run_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL, state TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO agent_run (id, status) VALUES ('run-1', 'RUNNING');
  `);
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('workflow checkpoints', () => {
  it('persists state with a renewable lease and increasing revision', () => {
    const database = createDb();
    const start = new Date('2026-10-16T00:00:00.000Z');
    const created = createWorkflowCheckpoint('run-1', { cursor: 2 }, 'owner-a', database, start);

    expect(created.state).toBe('RUNNING');
    expect(created.revision).toBe(1);
    expect(heartbeatWorkflowCheckpoint('run-1', 'owner-a', 1, database, new Date(start.getTime() + 10_000))).toBe(true);
    const revision = updateWorkflowCheckpoint('run-1', { cursor: 3 }, 'RUNNING', 'owner-a', 1, database, new Date(start.getTime() + 11_000));

    expect(revision).toBe(2);
    expect(getWorkflowCheckpoint('run-1', database)).toMatchObject({ revision: 2, snapshot: { cursor: 3 } });
    expect(() => updateWorkflowCheckpoint('run-1', { cursor: 4 }, 'RUNNING', 'owner-a', 1, database)).toThrow(/lease lost/);
  });

  it('claims an expired lease once and fences stale workers', () => {
    const database = createDb();
    const start = new Date('2026-10-16T00:00:00.000Z');
    const created = createWorkflowCheckpoint('run-1', { activeAction: 'agent' }, 'old-owner', database, start);
    const now = new Date(start.getTime() + 61_000);

    expect(listExpiredWorkflowCheckpoints(database, now)).toHaveLength(1);
    const claimed = claimExpiredWorkflowCheckpoint('run-1', 'new-owner', created.revision, database, now);
    expect(claimed).toMatchObject({ revision: 2, leaseOwner: 'new-owner' });
    expect(claimExpiredWorkflowCheckpoint('run-1', 'other-owner', created.revision, database, now)).toBeUndefined();
    expect(heartbeatWorkflowCheckpoint('run-1', 'old-owner', 1, database, now)).toBe(false);
  });

  it('finishes checkpoint and parent run atomically', () => {
    const database = createDb();
    const created = createWorkflowCheckpoint('run-1', { cursor: 4 }, 'owner-a', database);
    finishWorkflowCheckpoint('run-1', { cursor: 6 }, 'SUCCEEDED', 'owner-a', created.revision, {
      status: 'DONE', output: 'verdict: SHIP', durationMs: 42,
    }, database);

    expect(getWorkflowCheckpoint('run-1', database)).toMatchObject({
      state: 'SUCCEEDED', snapshot: { cursor: 6 }, leaseOwner: undefined,
    });
    expect(database.prepare('SELECT status, output, duration_ms FROM agent_run WHERE id = ?').get('run-1')).toEqual({
      status: 'DONE', output: 'verdict: SHIP', duration_ms: 42,
    });
  });

  it('claims a pending PR delivery for one retry without changing the verified parent result', () => {
    const database = createDb();
    const created = createWorkflowCheckpoint('run-1', { deliveryState: { status: 'DELIVERY_PENDING' } }, 'owner-a', database);
    finishWorkflowCheckpoint('run-1', { deliveryState: { status: 'DELIVERY_PENDING' } }, 'DELIVERY_PENDING', 'owner-a', created.revision, {
      status: 'DONE', output: '[DELIVERY: PENDING]', durationMs: 42,
    }, database);

    const pending = getWorkflowCheckpoint('run-1', database)!;
    const claimed = claimWorkflowDeliveryRetry('run-1', 'retry-owner', pending.revision, database);

    expect(claimed).toMatchObject({ state: 'RUNNING', revision: pending.revision + 1, leaseOwner: 'retry-owner' });
    expect(claimWorkflowDeliveryRetry('run-1', 'other-owner', pending.revision, database)).toBeUndefined();
    expect(database.prepare('SELECT status, output FROM agent_run WHERE id = ?').get('run-1')).toEqual({
      status: 'DONE', output: '[DELIVERY: PENDING]',
    });
  });
});
