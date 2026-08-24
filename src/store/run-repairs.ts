import type { Database as DatabaseType } from 'better-sqlite3';
import { isAnthropicAuthFailure } from '../llm/anthropic/auth-failure.js';

/**
 * Claude 비로그인 안내가 DONE으로 잘못 저장된 과거 실행을 교정한다.
 * 반환값은 수정한 child run 수다.
 */
export function repairAnthropicAuthFailures(db: DatabaseType): number {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, agent_name, output, workflow_run_id
      FROM agent_run
      WHERE status = 'DONE' AND output IS NOT NULL
      ORDER BY started_at ASC, id ASC
    `).all() as Array<{ id: string; agent_name: string; output: string; workflow_run_id?: string }>;

    const updateChild = db.prepare(`
      UPDATE agent_run
      SET status = 'FAILED', error_type = 'anthropic_auth_failed', stop_reason = 'authentication_required'
      WHERE id = ?
    `);
    const getParent = db.prepare('SELECT status, output FROM agent_run WHERE id = ?');
    const updateParent = db.prepare(`
      UPDATE agent_run
      SET status = 'FAILED', output = @output, error_type = 'workflow_failure', stop_reason = @stopReason
      WHERE id = @id AND status = 'DONE'
    `);
    let repaired = 0;

    for (const row of rows) {
      if (!isAnthropicAuthFailure(row.output)) continue;
      updateChild.run(row.id);
      repaired++;
      if (!row.workflow_run_id) continue;

      const parent = getParent.get(row.workflow_run_id) as { status: string; output?: string } | undefined;
      if (parent?.status !== 'DONE') continue;
      const previous = parent.output?.trim();
      const output = `verdict: FAILED\nfailure: ${row.agent_name} (FAILED)\n` +
        `failure cause: anthropic_auth_failed\nfailure reason:\n${row.output.trim()}` +
        (previous ? `\n\nPrevious summary:\n${previous}` : '');
      updateParent.run({ id: row.workflow_run_id, output, stopReason: row.agent_name });
    }

    return repaired;
  })();
}

/**
 * 최종 generic success 계약까지 저장됐지만 CLI 정리 timeout(124) 때문에 FAILED가 된
 * 과거 Codex child를 DONE으로 복구한다. 부모 workflow는 후속 단계가 실행되지 않았으므로
 * 완료로 바꾸지 않고, resume-last로 다음 단계를 이어갈 수 있는 명확한 실패 사유로 교정한다.
 */
export function repairCodexCompletedTimeouts(db: DatabaseType): number {
  const rows = db.prepare(`
    SELECT id, agent_name, output, workflow_run_id
    FROM agent_run
    WHERE status = 'FAILED' AND error_type = 'codex_cli_exit_124' AND output IS NOT NULL
    ORDER BY started_at ASC, id ASC
  `).all() as Array<{ id: string; agent_name: string; output: string; workflow_run_id?: string }>;
  const repairChild = db.prepare(`
    UPDATE agent_run
    SET status = 'DONE', error_type = NULL, stop_reason = 'codex_cli_exit_124_after_result'
    WHERE id = ?
  `);
  const repairParent = db.prepare(`
    UPDATE agent_run
    SET status = 'FAILED', error_type = 'workflow_incomplete', stop_reason = @stopReason,
        output = @output
    WHERE id = @id AND status = 'FAILED'
  `);
  let repaired = 0;

  for (const row of rows) {
    const start = row.output.indexOf('{');
    const end = row.output.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    let status = '';
    try {
      const parsed = JSON.parse(row.output.slice(start, end + 1)) as { status?: unknown };
      status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    } catch {
      continue;
    }
    if (status !== 'success') continue;

    repairChild.run(row.id);
    repaired++;
    if (row.workflow_run_id) {
      repairParent.run({
        id: row.workflow_run_id,
        stopReason: row.agent_name,
        output: `verdict: FAILED\nfailure: workflow incomplete after recovered ${row.agent_name}\n` +
          'failure cause: recovered_timeout_result\n' +
          'failure reason: The agent completed and returned a success result before the CLI timed out during cleanup. ' +
          'The result was recovered, but later workflow steps did not run. Use resume-last to continue.',
      });
    }
  }
  return repaired;
}
