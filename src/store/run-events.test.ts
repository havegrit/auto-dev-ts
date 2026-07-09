import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-events-'));
  process.env.AUTO_DEV_DB_PATH = join(dir, 'test.db');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('run event log', () => {
  it('persists emitted events in order', async () => {
    const { insertRun } = await import('./runs.js');
    const { appendRunEvent, getRunEvents } = await import('./run-events.js');

    insertRun({ id: 'run-1', agentName: 'spec', status: 'RUNNING', startedAt: new Date().toISOString() });
    appendRunEvent('run-1', { type: 'text', ts: '2026-01-01T00:00:00.000Z', data: 'hello' });
    appendRunEvent('run-1', { type: 'tool_call', ts: '2026-01-01T00:00:01.000Z', data: 'Read(file)' });

    expect(getRunEvents('run-1')).toEqual([
      { type: 'text', ts: '2026-01-01T00:00:00.000Z', data: 'hello' },
      { type: 'tool_call', ts: '2026-01-01T00:00:01.000Z', data: 'Read(file)' },
    ]);
  });
});
