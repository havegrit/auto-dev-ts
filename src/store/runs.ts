import { db } from './db.js';

export type RunStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'BLOCKED';

export interface RunRow {
  id: string;
  agent_name: string;
  input?: string;
  output?: string;
  tokens_in: number;
  tokens_out: number;
  status: RunStatus;
  started_at: string;
  duration_ms: number;
  trigger_source?: string;
  trigger_detail?: string;
  workflow_run_id?: string;
  spec_session_id?: string;
  model_id?: string;
  error_type?: string;
  stop_reason?: string;
  num_turns: number;
  clarification_state?: string;
  /**
   * 같은 spec 세션의 이전 시도들이 쓴 시간 합계. 재개(이어가기/재시도) run 은
   * duration_ms 에 이번 시도분만 담기므로, 화면에서 세션 전체 소요시간을 보여줄 때
   * 이 값을 더한다. 첫 시도이거나 하위 단계 run 이면 없음.
   */
  session_prior_duration_ms?: number;
}

export interface RunInsert {
  id: string;
  agentName: string;
  input?: string;
  output?: string;
  tokensIn?: number;
  tokensOut?: number;
  status: RunStatus;
  startedAt: string;
  durationMs?: number;
  triggerSource?: string;
  triggerDetail?: string;
  workflowRunId?: string;
  specSessionId?: string;
  modelId?: string;
}

export interface RunPatch {
  output?: string;
  tokensIn?: number;
  tokensOut?: number;
  status?: RunStatus;
  durationMs?: number;
  modelId?: string;
  errorType?: string;
  stopReason?: string;
  numTurns?: number;
}

// 문서 점검/커밋 후처리는 spec 완료 추적과 최근 실행 목록에서 숨긴다.
const HIDDEN_RECENT_AGENTS = ['checking-docs-before-commit', 'atomic-commit'] as const;

export function insertRun(row: RunInsert): void {
  db.prepare(`
    INSERT INTO agent_run (id, agent_name, input, output, tokens_in, tokens_out, status, started_at, duration_ms, trigger_source, trigger_detail, workflow_run_id, spec_session_id, model_id)
    VALUES (@id, @agentName, @input, @output, @tokensIn, @tokensOut, @status, @startedAt, @durationMs, @triggerSource, @triggerDetail, @workflowRunId, @specSessionId, @modelId)
  `).run({
    id: row.id,
    agentName: row.agentName,
    input: row.input ?? null,
    output: row.output ?? null,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    status: row.status,
    startedAt: row.startedAt,
    durationMs: row.durationMs ?? 0,
    triggerSource: row.triggerSource ?? null,
    triggerDetail: row.triggerDetail ?? null,
    workflowRunId: row.workflowRunId ?? null,
    specSessionId: row.specSessionId ?? null,
    modelId: row.modelId ?? null,
  });
}

export function updateRun(id: string, patch: RunPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.output !== undefined)    { sets.push('output = @output');             params.output = patch.output; }
  if (patch.tokensIn !== undefined)  { sets.push('tokens_in = @tokensIn');        params.tokensIn = patch.tokensIn; }
  if (patch.tokensOut !== undefined) { sets.push('tokens_out = @tokensOut');      params.tokensOut = patch.tokensOut; }
  if (patch.status !== undefined)    { sets.push('status = @status');             params.status = patch.status; }
  if (patch.durationMs !== undefined){ sets.push('duration_ms = @durationMs');    params.durationMs = patch.durationMs; }
  if (patch.modelId !== undefined)   { sets.push('model_id = @modelId');          params.modelId = patch.modelId; }
  if (patch.errorType !== undefined) { sets.push('error_type = @errorType');      params.errorType = patch.errorType; }
  if (patch.stopReason !== undefined){ sets.push('stop_reason = @stopReason');    params.stopReason = patch.stopReason; }
  if (patch.numTurns !== undefined)  { sets.push('num_turns = @numTurns');        params.numTurns = patch.numTurns; }

  if (sets.length === 0) return;
  db.prepare(`UPDATE agent_run SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function getRun(id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM agent_run WHERE id = ?').get(id) as RunRow | undefined;
}

/**
 * 같은 spec 세션에서 이 run 보다 먼저 실행된 시도들의 소요시간 합계.
 * 재개 run 은 새 agent_run 행으로 시작하므로 duration_ms 에 이번 시도분만 담긴다.
 * 세션 전체 소요시간을 보여주려면 이 값을 더해야 한다.
 */
function priorAttemptDurationMs(run: RunRow): number {
  if (run.agent_name !== 'spec' || run.workflow_run_id) return 0;
  const sessionId = run.spec_session_id ?? run.id;
  const row = db.prepare(`
    SELECT COALESCE(SUM(duration_ms), 0) as total FROM agent_run
    WHERE agent_name = 'spec' AND workflow_run_id IS NULL
      AND (spec_session_id = @sessionId OR id = @sessionId)
      AND id != @id
      AND (started_at < @startedAt OR (started_at = @startedAt AND id < @id))
  `).get({ sessionId, id: run.id, startedAt: run.started_at }) as { total: number };
  return row.total ?? 0;
}

function withSessionTotals(run: RunRow): RunRow {
  const prior = priorAttemptDurationMs(run);
  return prior > 0 ? { ...run, session_prior_duration_ms: prior } : run;
}

/** getRun 과 같지만, spec 재개 run 이면 이전 시도들의 누적 소요시간을 함께 실어준다. */
export function getRunWithSessionTotals(id: string): RunRow | undefined {
  const run = getRun(id);
  return run ? withSessionTotals(run) : undefined;
}

export function getRecentRuns(limit: number): RunRow[] {
  return db.prepare('SELECT * FROM agent_run ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export interface RecentRunsPage {
  rows: RunRow[];
  hasMore: boolean;
}

// 무한 스크롤용 유닛 단위 페이지. clarification 답변/후속 실행은 spec_session_id로
// 하나의 유닛으로 합치고, 해당 세션의 최신 spec row 뒤에 모든 단계 이력을 붙인다.
export function getRecentRunUnits(units: number): RecentRunsPage {
  const candidates = db.prepare(
    `SELECT * FROM agent_run
     WHERE workflow_run_id IS NULL
       AND agent_name NOT IN (${HIDDEN_RECENT_AGENTS.map(() => '?').join(',')})
     ORDER BY started_at DESC, id DESC`,
  ).all(...HIDDEN_RECENT_AGENTS) as RunRow[];
  const unique: RunRow[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const key = row.agent_name === 'spec' ? (row.spec_session_id ?? row.id) : row.id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= units + 1) break;
  }
  const hasMore = unique.length > units;
  const page = hasMore ? unique.slice(0, units) : unique;
  if (page.length === 0) return { rows: [], hasMore };

  const sessionIds = page
    .filter((row) => row.agent_name === 'spec')
    .map((row) => row.spec_session_id ?? row.id);
  const attempts = sessionIds.length === 0 ? [] : db.prepare(
    `SELECT id FROM agent_run
     WHERE agent_name = 'spec' AND workflow_run_id IS NULL
       AND (spec_session_id IN (${sessionIds.map(() => '?').join(',')})
            OR id IN (${sessionIds.map(() => '?').join(',')}))`,
  ).all(...sessionIds, ...sessionIds) as Array<{ id: string }>;
  const attemptIds = attempts.map((row) => row.id);
  const children = attemptIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM agent_run
     WHERE workflow_run_id IS NOT NULL
       AND agent_name NOT IN (${HIDDEN_RECENT_AGENTS.map(() => '?').join(',')})
       AND (spec_session_id IN (${sessionIds.map(() => '?').join(',')})
            OR workflow_run_id IN (${attemptIds.map(() => '?').join(',')}))
     ORDER BY started_at ASC, id ASC`,
  ).all(...HIDDEN_RECENT_AGENTS, ...sessionIds, ...attemptIds) as RunRow[];

  const childrenBySession = new Map<string, RunRow[]>();
  for (const child of children) {
    const key = child.spec_session_id ?? child.workflow_run_id!;
    const list = childrenBySession.get(key) ?? [];
    list.push(child);
    childrenBySession.set(key, list);
  }

  const rows: RunRow[] = [];
  for (const parent of page) {
    // 유닛 대표 행은 세션의 최신 시도다. 이전 시도들의 소요시간을 실어 보내
    // 화면이 세션 전체 소요시간(이전 누적 + 이번 시도)을 보여줄 수 있게 한다.
    rows.push(withSessionTotals(parent));
    const kids = childrenBySession.get(parent.spec_session_id ?? parent.id);
    if (kids) rows.push(...kids);
  }
  return { rows, hasMore };
}

export function getRunsByWorkflowId(workflowRunId: string): RunRow[] {
  return db.prepare('SELECT * FROM agent_run WHERE workflow_run_id = ? ORDER BY started_at ASC').all(workflowRunId) as RunRow[];
}

export function getRunsBySpecSessionId(specSessionId: string): RunRow[] {
  return db.prepare(`
    SELECT * FROM agent_run
    WHERE workflow_run_id IS NOT NULL
      AND agent_name NOT IN (${HIDDEN_RECENT_AGENTS.map(() => '?').join(',')})
      AND (spec_session_id = ? OR workflow_run_id IN (
        SELECT id FROM agent_run
        WHERE agent_name = 'spec' AND workflow_run_id IS NULL
          AND (spec_session_id = ? OR id = ?)
      ))
    ORDER BY started_at ASC, id ASC
  `).all(...HIDDEN_RECENT_AGENTS, specSessionId, specSessionId, specSessionId) as RunRow[];
}

export function getStats(): object {
  const total = (db.prepare('SELECT COUNT(*) as count FROM agent_run').get() as { count: number }).count;
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const todayStartUtc = new Date(`${todayStr}T00:00:00+09:00`).toISOString();
  const todayCount = (db.prepare("SELECT COUNT(*) as count FROM agent_run WHERE started_at >= ?").get(todayStartUtc) as { count: number }).count;
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM agent_run GROUP BY status').all();
  const byAgent = db.prepare(`
    SELECT agent_name,
           COUNT(*) as count,
           SUM(CASE WHEN status = 'DONE'   THEN 1 ELSE 0 END) as doneCount,
           SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failedCount,
           AVG(CASE WHEN status = 'DONE' THEN duration_ms END) as avgDurationMs
    FROM agent_run
    GROUP BY agent_name
  `).all();
  return { total, todayCount, byStatus, byAgent };
}
