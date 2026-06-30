import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-clar-'));
  process.env.AUTO_DEV_DB_PATH = join(dir, 'test.db');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('clarification state store', () => {
  it('round-trips a clarification state for a run', async () => {
    const { insertRun } = await import('./runs.js');
    const { saveClarificationState, getClarificationState } = await import('./clarification.js');

    insertRun({ id: 'run-1', agentName: 'spec', status: 'RUNNING', startedAt: new Date().toISOString() });

    const state = {
      spec: '원본 스펙',
      project: 'my-api',
      slug: 'my-api',
      planFile: 'docs/plan/my-api.md',
      cwd: '/tmp/proj',
      rounds: [
        { questions: [{ id: 'q1', category: 'scope', text: '범위는?', recommendation: 'CRUD' }], answers: { q1: 'CRUD' } },
      ],
    };

    saveClarificationState('run-1', state);
    expect(getClarificationState('run-1')).toEqual(state);
  });

  it('returns undefined when a run has no clarification state', async () => {
    const { insertRun } = await import('./runs.js');
    const { getClarificationState } = await import('./clarification.js');

    insertRun({ id: 'run-2', agentName: 'spec', status: 'RUNNING', startedAt: new Date().toISOString() });
    expect(getClarificationState('run-2')).toBeUndefined();
  });
});
