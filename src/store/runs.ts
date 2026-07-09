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
  model_id?: string;
  error_type?: string;
  stop_reason?: string;
  num_turns: number;
  clarification_state?: string;
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

export function insertRun(row: RunInsert): void {
  db.prepare(`
    INSERT INTO agent_run (id, agent_name, input, output, tokens_in, tokens_out, status, started_at, duration_ms, trigger_source, trigger_detail, workflow_run_id, model_id)
    VALUES (@id, @agentName, @input, @output, @tokensIn, @tokensOut, @status, @startedAt, @durationMs, @triggerSource, @triggerDetail, @workflowRunId, @modelId)
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

export function getRecentRuns(limit: number): RunRow[] {
  return db.prepare('SELECT * FROM agent_run ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export interface RecentRunsPage {
  rows: RunRow[];
  hasMore: boolean;
}

// 무한 스크롤용 유닛 단위 페이지. 유닛 = 최상위 run(workflow_run_id 없는 spec 부모 또는 단독 실행).
// 최신 유닛 units 개를 부모 시작순 내림차순으로 뽑고, 각 부모 뒤에 자식 단계를 시작순으로 붙여
// 표시 순서 그대로 평면 배열로 돌려준다. hasMore 는 다음 페이지 존재 여부.
export function getRecentRunUnits(units: number): RecentRunsPage {
  const parents = db.prepare(
    'SELECT * FROM agent_run WHERE workflow_run_id IS NULL ORDER BY started_at DESC, id DESC LIMIT ?',
  ).all(units + 1) as RunRow[];
  const hasMore = parents.length > units;
  const page = hasMore ? parents.slice(0, units) : parents;
  if (page.length === 0) return { rows: [], hasMore };

  const placeholders = page.map(() => '?').join(',');
  const children = db.prepare(
    `SELECT * FROM agent_run WHERE workflow_run_id IN (${placeholders}) ORDER BY started_at ASC`,
  ).all(...page.map((p) => p.id)) as RunRow[];

  const childrenByParent = new Map<string, RunRow[]>();
  for (const child of children) {
    const list = childrenByParent.get(child.workflow_run_id!) ?? [];
    list.push(child);
    childrenByParent.set(child.workflow_run_id!, list);
  }

  const rows: RunRow[] = [];
  for (const parent of page) {
    rows.push(parent);
    const kids = childrenByParent.get(parent.id);
    if (kids) rows.push(...kids);
  }
  return { rows, hasMore };
}

export function getRunsByWorkflowId(workflowRunId: string): RunRow[] {
  return db.prepare('SELECT * FROM agent_run WHERE workflow_run_id = ? ORDER BY started_at ASC').all(workflowRunId) as RunRow[];
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
