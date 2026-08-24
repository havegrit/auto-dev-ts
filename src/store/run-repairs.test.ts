import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { repairAnthropicAuthFailures, repairCodexCompletedTimeouts } from './run-repairs.js';

describe('repairAnthropicAuthFailures', () => {
  it('marks login outputs and their successful workflow parent as failed', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_run (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        workflow_run_id TEXT,
        error_type TEXT,
        stop_reason TEXT
      );
      INSERT INTO agent_run (id, agent_name, output, status, started_at)
      VALUES ('parent', 'spec', 'planner: DONE, test: DONE\nverdict: SHIP', 'DONE', '2026-01-01T00:00:00Z');
      INSERT INTO agent_run (id, agent_name, output, status, started_at, workflow_run_id)
      VALUES ('planner', 'planner', 'Not logged in · Please run /login', 'DONE', '2026-01-01T00:00:01Z', 'parent');
      INSERT INTO agent_run (id, agent_name, output, status, started_at, workflow_run_id)
      VALUES ('test', 'test', 'Not logged in · Please run /login', 'DONE', '2026-01-01T00:00:02Z', 'parent');
      INSERT INTO agent_run (id, agent_name, output, status, started_at, workflow_run_id)
      VALUES ('org-disabled', 'planner', 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access', 'DONE', '2026-01-01T00:00:02.500Z', 'parent');
      INSERT INTO agent_run (id, agent_name, output, status, started_at)
      VALUES ('normal', 'planner', 'Add a /login route to the application.', 'DONE', '2026-01-01T00:00:03Z');
    `);

    expect(repairAnthropicAuthFailures(db)).toBe(3);

    const planner = db.prepare('SELECT status, error_type, stop_reason FROM agent_run WHERE id = ?').get('planner') as any;
    const test = db.prepare('SELECT status, error_type, stop_reason FROM agent_run WHERE id = ?').get('test') as any;
    const orgDisabled = db.prepare('SELECT status, error_type, stop_reason FROM agent_run WHERE id = ?').get('org-disabled') as any;
    const parent = db.prepare('SELECT status, error_type, stop_reason, output FROM agent_run WHERE id = ?').get('parent') as any;
    const normal = db.prepare('SELECT status FROM agent_run WHERE id = ?').get('normal') as any;

    expect(planner).toEqual({ status: 'FAILED', error_type: 'anthropic_auth_failed', stop_reason: 'authentication_required' });
    expect(test).toEqual({ status: 'FAILED', error_type: 'anthropic_auth_failed', stop_reason: 'authentication_required' });
    expect(orgDisabled).toEqual({ status: 'FAILED', error_type: 'anthropic_auth_failed', stop_reason: 'authentication_required' });
    expect(parent).toMatchObject({ status: 'FAILED', error_type: 'workflow_failure', stop_reason: 'planner' });
    expect(parent.output).toContain('verdict: FAILED');
    expect(parent.output).toContain('failure: planner (FAILED)');
    expect(normal.status).toBe('DONE');

    db.close();
  });
});

describe('repairCodexCompletedTimeouts', () => {
  it('recovers a complete child result and leaves its interrupted workflow resumable', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_run (
        id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, output TEXT, status TEXT NOT NULL,
        started_at TEXT NOT NULL, workflow_run_id TEXT, error_type TEXT, stop_reason TEXT
      );
      INSERT INTO agent_run VALUES
        ('parent', 'spec', 'scaffold: FAILED', 'FAILED', '2026-01-01T00:00:00Z', NULL, 'workflow_failure', 'scaffold'),
        ('child', 'scaffold', '{"status":"success","summary":"done"}', 'FAILED', '2026-01-01T00:00:01Z', 'parent', 'codex_cli_exit_124', 'codex_cli_exit_124'),
        ('bad', 'scaffold', 'partial output', 'FAILED', '2026-01-01T00:00:02Z', 'parent', 'codex_cli_exit_124', 'codex_cli_exit_124');
    `);

    expect(repairCodexCompletedTimeouts(db)).toBe(1);
    expect(db.prepare('SELECT status, error_type, stop_reason FROM agent_run WHERE id = ?').get('child')).toEqual({
      status: 'DONE', error_type: null, stop_reason: 'codex_cli_exit_124_after_result',
    });
    const parent = db.prepare('SELECT status, error_type, output FROM agent_run WHERE id = ?').get('parent') as any;
    expect(parent).toMatchObject({ status: 'FAILED', error_type: 'workflow_incomplete' });
    expect(parent.output).toContain('Use resume-last to continue');
    expect(db.prepare('SELECT status FROM agent_run WHERE id = ?').get('bad')).toEqual({ status: 'FAILED' });
    db.close();
  });
});
