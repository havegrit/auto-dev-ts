import { db } from './db.js';
import type { RunEvent } from '../lib/run-events.js';

export function appendRunEvent(runId: string, event: RunEvent): void {
  db.prepare(`
    INSERT INTO agent_run_event (run_id, ts, type, data)
    VALUES (@runId, @ts, @type, @data)
  `).run({
    runId,
    ts: event.ts,
    type: event.type,
    data: event.data,
  });
}

export function getRunEvents(runId: string): RunEvent[] {
  return db.prepare(`
    SELECT ts, type, data
    FROM agent_run_event
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId) as RunEvent[];
}
