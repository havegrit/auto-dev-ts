import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autodev-runs-'));
  process.env.AUTO_DEV_DB_PATH = join(dir, 'test.db');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getRecentRuns', () => {
  it('returns all runs ordered by recency so child workflow steps are visible too', async () => {
    const { insertRun, getRecentRuns } = await import('./runs.js');

    // 최상위 spec run + 그 아래 자식 단계 여러 개 + 별도 최상위 review run
    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    insertRun({ id: 'spec-1', agentName: 'spec', status: 'RUNNING', startedAt: t(0) });
    for (let i = 0; i < 6; i++) {
      insertRun({ id: `child-${i}`, agentName: 'planner', status: 'DONE', startedAt: t(1 + i), workflowRunId: 'spec-1' });
    }
    insertRun({ id: 'review-1', agentName: 'review', status: 'DONE', startedAt: t(10) });

    const recent = getRecentRuns(3);

    expect(recent.map((r) => r.id)).toEqual(['review-1', 'child-5', 'child-4']);
    expect(recent.some((r) => r.workflow_run_id === 'spec-1')).toBe(true);
  });
});

describe('getRecentRunUnits', () => {
  it('pages by top-level unit (spec workflow or standalone run), parent then children', async () => {
    const { insertRun, getRecentRunUnits } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');

    const t = (n: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString();
    // 오래된 것부터: spec-A(자식3) -> 단독 review -> spec-B(자식2)
    insertRun({ id: 'spec-A', agentName: 'spec', status: 'DONE', startedAt: t(0) });
    insertRun({ id: 'a-1', agentName: 'planner', status: 'DONE', startedAt: t(1), workflowRunId: 'spec-A' });
    insertRun({ id: 'a-2', agentName: 'scaffold', status: 'DONE', startedAt: t(2), workflowRunId: 'spec-A' });
    insertRun({ id: 'a-3', agentName: 'review', status: 'DONE', startedAt: t(3), workflowRunId: 'spec-A' });
    insertRun({ id: 'solo', agentName: 'review', status: 'DONE', startedAt: t(4) });
    insertRun({ id: 'spec-B', agentName: 'spec', status: 'RUNNING', startedAt: t(5) });
    insertRun({ id: 'b-1', agentName: 'planner', status: 'DONE', startedAt: t(6), workflowRunId: 'spec-B' });
    insertRun({ id: 'b-2', agentName: 'scaffold', status: 'RUNNING', startedAt: t(7), workflowRunId: 'spec-B' });

    // 첫 2 유닛: spec-B(+자식) 와 단독 solo. spec-A 는 아직.
    const page1 = getRecentRunUnits(2);
    expect(page1.rows.map((r) => r.id)).toEqual(['spec-B', 'b-1', 'b-2', 'solo']);
    expect(page1.hasMore).toBe(true);

    // 3 유닛: 전부 (부모는 시작순 내림차순, 그 안에서 자식은 시작순 오름차순)
    const page2 = getRecentRunUnits(3);
    expect(page2.rows.map((r) => r.id)).toEqual(['spec-B', 'b-1', 'b-2', 'solo', 'spec-A', 'a-1', 'a-2', 'a-3']);
    expect(page2.hasMore).toBe(false);
  });
});

describe('getStats', () => {
  it('counts today from Asia/Seoul midnight converted to a UTC ISO timestamp', async () => {
    const { insertRun, getStats } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T15:30:00.000Z'));

    insertRun({ id: 'yesterday-kst', agentName: 'spec', status: 'DONE', startedAt: '2026-07-07T14:59:59.999Z' });
    insertRun({ id: 'midnight-kst', agentName: 'spec', status: 'DONE', startedAt: '2026-07-07T15:00:00.000Z' });
    insertRun({ id: 'before-9am-utc', agentName: 'review', status: 'DONE', startedAt: '2026-07-07T23:30:00.000Z' });

    expect(getStats()).toMatchObject({ total: 3, todayCount: 2 });
  });
});
