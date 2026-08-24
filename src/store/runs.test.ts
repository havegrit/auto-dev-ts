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

  it('groups clarification resume attempts as one spec unit', async () => {
    const { insertRun, getRecentRunUnits, getRunsBySpecSessionId } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 3, 0, 0, n)).toISOString();

    insertRun({ id: 'spec-root', agentName: 'spec', status: 'DONE', startedAt: t(0), specSessionId: 'spec-root' });
    insertRun({ id: 'clarifier-1', agentName: 'clarifier', status: 'DONE', startedAt: t(1), workflowRunId: 'spec-root', specSessionId: 'spec-root' });
    insertRun({ id: 'spec-resumed', agentName: 'spec', status: 'RUNNING', startedAt: t(2), specSessionId: 'spec-root' });
    insertRun({ id: 'planner-2', agentName: 'planner', status: 'RUNNING', startedAt: t(3), workflowRunId: 'spec-resumed', specSessionId: 'spec-root' });

    const page = getRecentRunUnits(10);
    expect(page.rows.map((row) => row.id)).toEqual(['spec-resumed', 'clarifier-1', 'planner-2']);
    expect(getRunsBySpecSessionId('spec-root').map((row) => row.id)).toEqual(['clarifier-1', 'planner-2']);
  });

  it('hides background docs and commit agents from recent run units', async () => {
    const { insertRun, getRecentRunUnits } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 3, 1, 0, n)).toISOString();

    insertRun({ id: 'docs', agentName: 'checking-docs-before-commit', status: 'DONE', startedAt: t(2) });
    insertRun({ id: 'commit', agentName: 'atomic-commit', status: 'DONE', startedAt: t(1) });
    insertRun({ id: 'review', agentName: 'review', status: 'DONE', startedAt: t(0) });

    expect(getRecentRunUnits(10).rows.map((row) => row.id)).toEqual(['review']);
  });

  it('carries earlier attempt durations on the spec unit row so resumed runs show total elapsed', async () => {
    const { insertRun, getRecentRunUnits } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 4, 0, 0, n)).toISOString();

    // 재시도 한도로 실패한 1차 시도(60초) → 마지막 단계부터 재개한 2차 시도(진행 중).
    insertRun({ id: 'spec-1st', agentName: 'spec', status: 'FAILED', startedAt: t(0), durationMs: 60_000, specSessionId: 'spec-1st' });
    insertRun({ id: 'planner-1', agentName: 'planner', status: 'DONE', startedAt: t(1), durationMs: 40_000, workflowRunId: 'spec-1st', specSessionId: 'spec-1st' });
    insertRun({ id: 'spec-2nd', agentName: 'spec', status: 'RUNNING', startedAt: t(70), specSessionId: 'spec-1st' });
    insertRun({ id: 'review-2', agentName: 'review', status: 'RUNNING', startedAt: t(71), workflowRunId: 'spec-2nd', specSessionId: 'spec-1st' });
    insertRun({ id: 'solo', agentName: 'review', status: 'DONE', startedAt: t(80), durationMs: 5_000 });

    const rows = getRecentRunUnits(10).rows;
    const unit = rows.find((row) => row.id === 'spec-2nd');
    expect(unit?.session_prior_duration_ms).toBe(60_000);
    // 단독 실행과 자식 행에는 누적분이 붙지 않는다.
    expect(rows.find((row) => row.id === 'solo')?.session_prior_duration_ms).toBeUndefined();
    expect(rows.find((row) => row.id === 'review-2')?.session_prior_duration_ms).toBeUndefined();
  });

  it('leaves the first attempt of a session without prior duration', async () => {
    const { insertRun, getRecentRunUnits } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 5, 0, 0, n)).toISOString();

    insertRun({ id: 'spec-only', agentName: 'spec', status: 'DONE', startedAt: t(0), durationMs: 30_000, specSessionId: 'spec-only' });
    insertRun({ id: 'planner-only', agentName: 'planner', status: 'DONE', startedAt: t(1), durationMs: 30_000, workflowRunId: 'spec-only', specSessionId: 'spec-only' });

    const rows = getRecentRunUnits(10).rows;
    expect(rows.find((row) => row.id === 'spec-only')?.session_prior_duration_ms).toBeUndefined();
  });
});

describe('getRunWithSessionTotals', () => {
  it('adds prior attempt duration to a resumed spec run', async () => {
    const { insertRun, getRunWithSessionTotals } = await import('./runs.js');
    const { db } = await import('./db.js');
    db.exec('DELETE FROM agent_run');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 6, 0, 0, n)).toISOString();

    insertRun({ id: 'sess-1', agentName: 'spec', status: 'FAILED', startedAt: t(0), durationMs: 12_000, specSessionId: 'sess-1' });
    insertRun({ id: 'sess-2', agentName: 'spec', status: 'FAILED', startedAt: t(20), durationMs: 8_000, specSessionId: 'sess-1' });
    insertRun({ id: 'sess-3', agentName: 'spec', status: 'RUNNING', startedAt: t(40), specSessionId: 'sess-1' });
    insertRun({ id: 'child-1', agentName: 'review', status: 'DONE', startedAt: t(41), durationMs: 3_000, workflowRunId: 'sess-3', specSessionId: 'sess-1' });

    expect(getRunWithSessionTotals('sess-3')?.session_prior_duration_ms).toBe(20_000);
    expect(getRunWithSessionTotals('sess-1')?.session_prior_duration_ms).toBeUndefined();
    // 하위 단계 run 은 그 단계의 소요시간만 유지한다.
    expect(getRunWithSessionTotals('child-1')?.session_prior_duration_ms).toBeUndefined();
    expect(getRunWithSessionTotals('nope')).toBeUndefined();
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
