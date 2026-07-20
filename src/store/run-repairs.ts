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
