import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { db as appDb } from './db.js';
import type { AutoMergeDryRunResult } from '../lib/auto-merge.js';
import type { AutoMergeActionResult } from '../lib/auto-merge-execution.js';

export const WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1;
export const WORKFLOW_CHECKPOINT_LEASE_MS = 60_000;

export type WorkflowCheckpointState =
  | 'READY'
  | 'RUNNING'
  | 'WAITING_USER'
  | 'DELIVERY_PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export interface WorkflowCheckpointSnapshot {
  [key: string]: unknown;
}

export interface WorkflowCheckpointRow {
  workflow_run_id: string;
  schema_version: number;
  revision: number;
  state: WorkflowCheckpointState;
  snapshot_json: string;
  lease_owner?: string;
  lease_expires_at?: string;
  heartbeat_at?: string;
  updated_at: string;
}

export interface WorkflowCheckpoint {
  workflowRunId: string;
  schemaVersion: number;
  revision: number;
  state: WorkflowCheckpointState;
  snapshot: WorkflowCheckpointSnapshot;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  updatedAt: string;
}

export interface WorkflowCheckpointSummary {
  state: WorkflowCheckpointState;
  revision: number;
  action?: string;
  step?: string;
  cursor?: number;
  routeCount?: number;
  recoveryReason?: string;
  delivery?: {
    status?: string;
    branch?: string;
    baseBranch?: string;
    baseSha?: string;
    commitSha?: string;
    prUrl?: string;
    reason?: string;
  };
  autoMergeDryRun?: AutoMergeDryRunResult;
  autoMergeAction?: AutoMergeActionResult;
  updatedAt: string;
}

export interface CheckpointRunTerminalPatch {
  status: 'DONE' | 'FAILED';
  output: string;
  durationMs: number;
  errorType?: string;
  stopReason?: string;
}

export function createCheckpointLeaseOwner(): string {
  return JSON.stringify({ host: hostname(), pid: process.pid, nonce: randomUUID() });
}

function parseRow(row: WorkflowCheckpointRow | undefined): WorkflowCheckpoint | undefined {
  if (!row) return undefined;
  let snapshot: WorkflowCheckpointSnapshot;
  try {
    const parsed: unknown = JSON.parse(row.snapshot_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot must be an object');
    snapshot = parsed as WorkflowCheckpointSnapshot;
  } catch (err) {
    throw new Error(`Invalid workflow checkpoint ${row.workflow_run_id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    workflowRunId: row.workflow_run_id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    state: row.state,
    snapshot,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function parseRecoveryRow(row: WorkflowCheckpointRow): WorkflowCheckpoint {
  try {
    return parseRow(row)!;
  } catch {
    // 손상된 JSON도 recovery-required로 노출할 수 있도록 행의 lease 메타데이터를 유지한다.
    return {
      workflowRunId: row.workflow_run_id,
      schemaVersion: row.schema_version,
      revision: row.revision,
      state: row.state,
      snapshot: { invalidSnapshotJson: true },
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      heartbeatAt: row.heartbeat_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }
}

export function createWorkflowCheckpoint(
  workflowRunId: string,
  snapshot: WorkflowCheckpointSnapshot,
  leaseOwner: string,
  database: DatabaseType = appDb,
  now = new Date(),
): WorkflowCheckpoint {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_CHECKPOINT_LEASE_MS).toISOString();
  database.prepare(`
    INSERT INTO workflow_checkpoint (
      workflow_run_id, schema_version, revision, state, snapshot_json,
      lease_owner, lease_expires_at, heartbeat_at, updated_at
    ) VALUES (?, ?, 1, 'RUNNING', ?, ?, ?, ?, ?)
  `).run(workflowRunId, WORKFLOW_CHECKPOINT_SCHEMA_VERSION, JSON.stringify(snapshot), leaseOwner, leaseExpiresAt, timestamp, timestamp);
  return getWorkflowCheckpoint(workflowRunId, database)!;
}

export function getWorkflowCheckpoint(workflowRunId: string, database: DatabaseType = appDb): WorkflowCheckpoint | undefined {
  const row = database.prepare('SELECT * FROM workflow_checkpoint WHERE workflow_run_id = ?').get(workflowRunId) as WorkflowCheckpointRow | undefined;
  return parseRow(row);
}

export function updateWorkflowCheckpoint(
  workflowRunId: string,
  snapshot: WorkflowCheckpointSnapshot,
  state: WorkflowCheckpointState,
  leaseOwner: string,
  expectedRevision: number,
  database: DatabaseType = appDb,
  now = new Date(),
): number {
  const timestamp = now.toISOString();
  const active = state === 'RUNNING';
  const leaseExpiresAt = active ? new Date(now.getTime() + WORKFLOW_CHECKPOINT_LEASE_MS).toISOString() : null;
  const result = database.prepare(`
    UPDATE workflow_checkpoint
    SET snapshot_json = ?, state = ?, revision = revision + 1,
        lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE workflow_run_id = ? AND revision = ? AND lease_owner = ?
  `).run(
    JSON.stringify(snapshot), state, active ? leaseOwner : null, leaseExpiresAt,
    active ? timestamp : null, timestamp, workflowRunId, expectedRevision, leaseOwner,
  );
  if (result.changes !== 1) throw new Error(`Workflow checkpoint lease lost: ${workflowRunId}`);
  return expectedRevision + 1;
}

export function heartbeatWorkflowCheckpoint(
  workflowRunId: string,
  leaseOwner: string,
  revision: number,
  database: DatabaseType = appDb,
  now = new Date(),
): boolean {
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + WORKFLOW_CHECKPOINT_LEASE_MS).toISOString();
  const result = database.prepare(`
    UPDATE workflow_checkpoint
    SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE workflow_run_id = ? AND state = 'RUNNING' AND lease_owner = ? AND revision = ?
  `).run(expiresAt, timestamp, timestamp, workflowRunId, leaseOwner, revision);
  return result.changes === 1;
}

/** 체크포인트 종료와 부모 run 상태를 한 transaction으로 기록한다. */
export function finishWorkflowCheckpoint(
  workflowRunId: string,
  snapshot: WorkflowCheckpointSnapshot,
  state: WorkflowCheckpointState,
  leaseOwner: string,
  expectedRevision: number,
  runPatch: CheckpointRunTerminalPatch,
  database: DatabaseType = appDb,
  now = new Date(),
): number {
  const timestamp = now.toISOString();
  return database.transaction(() => {
    const checkpoint = database.prepare(`
      UPDATE workflow_checkpoint
      SET snapshot_json = ?, state = ?, revision = revision + 1,
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
      WHERE workflow_run_id = ? AND revision = ? AND lease_owner = ?
    `).run(JSON.stringify(snapshot), state, timestamp, workflowRunId, expectedRevision, leaseOwner);
    if (checkpoint.changes !== 1) throw new Error(`Workflow checkpoint lease lost: ${workflowRunId}`);
    const run = database.prepare(`
      UPDATE agent_run
      SET output = ?, status = ?, duration_ms = ?, error_type = ?, stop_reason = ?
      WHERE id = ?
    `).run(
      runPatch.output, runPatch.status, runPatch.durationMs,
      runPatch.errorType ?? null, runPatch.stopReason ?? null, workflowRunId,
    );
    if (run.changes !== 1) throw new Error(`Workflow run not found: ${workflowRunId}`);
    return expectedRevision + 1;
  })();
}

export function listExpiredWorkflowCheckpoints(
  database: DatabaseType = appDb,
  now = new Date(),
): WorkflowCheckpoint[] {
  const rows = database.prepare(`
    SELECT * FROM workflow_checkpoint
    WHERE state = 'RUNNING' AND lease_expires_at <= ?
    ORDER BY updated_at ASC
  `).all(now.toISOString()) as WorkflowCheckpointRow[];
  return rows.map(parseRecoveryRow);
}

/** 만료된 lease만 revision을 올리며 원자적으로 claim한다. */
export function claimExpiredWorkflowCheckpoint(
  workflowRunId: string,
  leaseOwner: string,
  expectedRevision: number,
  database: DatabaseType = appDb,
  now = new Date(),
): WorkflowCheckpoint | undefined {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_CHECKPOINT_LEASE_MS).toISOString();
  const result = database.prepare(`
    UPDATE workflow_checkpoint
    SET revision = revision + 1, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE workflow_run_id = ? AND state = 'RUNNING' AND revision = ? AND lease_expires_at <= ?
  `).run(leaseOwner, leaseExpiresAt, timestamp, timestamp, workflowRunId, expectedRevision, timestamp);
  if (result.changes !== 1) return undefined;
  const row = database.prepare('SELECT * FROM workflow_checkpoint WHERE workflow_run_id = ?').get(workflowRunId) as WorkflowCheckpointRow;
  return parseRecoveryRow(row);
}

/** DELIVERY_PENDING PR 전달을 사용자 재시도 요청으로 원자적으로 claim한다. */
export function claimWorkflowDeliveryRetry(
  workflowRunId: string,
  leaseOwner: string,
  expectedRevision: number,
  database: DatabaseType = appDb,
  now = new Date(),
): WorkflowCheckpoint | undefined {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_CHECKPOINT_LEASE_MS).toISOString();
  const result = database.prepare(`
    UPDATE workflow_checkpoint
    SET state = 'RUNNING', revision = revision + 1, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE workflow_run_id = ? AND state = 'DELIVERY_PENDING' AND revision = ?
  `).run(leaseOwner, leaseExpiresAt, timestamp, timestamp, workflowRunId, expectedRevision);
  if (result.changes !== 1) return undefined;
  const row = database.prepare('SELECT * FROM workflow_checkpoint WHERE workflow_run_id = ?').get(workflowRunId) as WorkflowCheckpointRow;
  return parseRow(row);
}

export function checkpointSummary(checkpoint: WorkflowCheckpoint): WorkflowCheckpointSummary {
  const snapshot = checkpoint.snapshot;
  const sessionState = snapshot['sessionState'] && typeof snapshot['sessionState'] === 'object'
    ? snapshot['sessionState'] as Record<string, unknown>
    : undefined;
  const deliveryContext = sessionState?.['deliveryContext'] && typeof sessionState['deliveryContext'] === 'object'
    ? sessionState['deliveryContext'] as Record<string, unknown>
    : snapshot['deliveryContext'] && typeof snapshot['deliveryContext'] === 'object'
      ? snapshot['deliveryContext'] as Record<string, unknown>
      : undefined;
  const deliveryState = snapshot['deliveryState'] && typeof snapshot['deliveryState'] === 'object'
    ? snapshot['deliveryState'] as Record<string, unknown>
    : deliveryContext?.['state'] && typeof deliveryContext['state'] === 'object'
      ? deliveryContext['state'] as Record<string, unknown>
      : undefined;
  const autoMergeDryRun = snapshot['autoMergeDryRun'] && typeof snapshot['autoMergeDryRun'] === 'object'
    ? snapshot['autoMergeDryRun'] as AutoMergeDryRunResult
    : undefined;
  const autoMergeAction = snapshot['autoMergeAction'] && typeof snapshot['autoMergeAction'] === 'object'
    ? snapshot['autoMergeAction'] as AutoMergeActionResult
    : undefined;
  return {
    state: checkpoint.state,
    revision: checkpoint.revision,
    ...(typeof snapshot['activeAction'] === 'string' ? { action: snapshot['activeAction'] } : {}),
    ...(typeof snapshot['activeStep'] === 'string' ? { step: snapshot['activeStep'] } : {}),
    ...(typeof snapshot['cursor'] === 'number' ? { cursor: snapshot['cursor'] } : {}),
    ...(typeof snapshot['routeCount'] === 'number' ? { routeCount: snapshot['routeCount'] } : {}),
    ...(typeof snapshot['recoveryReason'] === 'string' ? { recoveryReason: snapshot['recoveryReason'] } : {}),
    ...(deliveryContext || deliveryState ? {
      delivery: {
        ...(typeof deliveryState?.['status'] === 'string' ? { status: deliveryState['status'] } : {}),
        ...(typeof deliveryContext?.['branch'] === 'string' ? { branch: deliveryContext['branch'] } : {}),
        ...(typeof deliveryContext?.['baseBranch'] === 'string' ? { baseBranch: deliveryContext['baseBranch'] } : {}),
        ...(typeof deliveryContext?.['baseSha'] === 'string' ? { baseSha: deliveryContext['baseSha'] } : {}),
        ...(typeof deliveryState?.['commitSha'] === 'string' ? { commitSha: deliveryState['commitSha'] } : {}),
        ...(typeof deliveryState?.['prUrl'] === 'string' ? { prUrl: deliveryState['prUrl'] } : {}),
        ...(typeof deliveryState?.['reason'] === 'string' ? { reason: deliveryState['reason'] } : {}),
      },
    } : {}),
    ...(autoMergeDryRun ? { autoMergeDryRun } : {}),
    ...(autoMergeAction ? { autoMergeAction } : {}),
    updatedAt: checkpoint.updatedAt,
  };
}
