CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  input TEXT,
  output TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','DONE','FAILED','BLOCKED')),
  started_at TEXT NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  trigger_source TEXT,
  trigger_detail TEXT,
  workflow_run_id TEXT,
  error_type TEXT,
  stop_reason TEXT,
  num_turns INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_run_started ON agent_run(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_workflow ON agent_run(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_run_agent ON agent_run(agent_name);
