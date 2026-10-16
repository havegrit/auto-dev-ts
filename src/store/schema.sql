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
  spec_session_id TEXT,
  model_id TEXT,
  error_type TEXT,
  stop_reason TEXT,
  num_turns INTEGER DEFAULT 0,
  clarification_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_started ON agent_run(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_workflow ON agent_run(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_run_agent ON agent_run(agent_name);

CREATE TABLE IF NOT EXISTS agent_run_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES agent_run(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_event_run ON agent_run_event(run_id, id);

CREATE TABLE IF NOT EXISTS workflow_checkpoint (
  workflow_run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('READY','RUNNING','WAITING_USER','DELIVERY_PENDING','SUCCEEDED','FAILED','CANCELLED','RECOVERY_REQUIRED')),
  snapshot_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workflow_run_id) REFERENCES agent_run(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoint_recovery
  ON workflow_checkpoint(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS review_finding (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  rule_hint TEXT NOT NULL,
  file TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_finding_project_created
  ON review_finding(project, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_merge_dry_run (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('docs','dependency-patch','ineligible')),
  policy_fingerprint TEXT NOT NULL,
  eval_pass_count INTEGER NOT NULL DEFAULT 0,
  eval_distinct_case_count INTEGER NOT NULL DEFAULT 0,
  live_pass_count INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
  reasons_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(workflow_run_id) REFERENCES agent_run(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auto_merge_dry_run_workflow
  ON auto_merge_dry_run(workflow_run_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS auto_merge_live_observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('docs','dependency-patch')),
  policy_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('stable','reverted','hotfix','rework','unknown')),
  merged_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  evidence_source TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  stability_verified_at TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE(repository, base_branch, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS idx_auto_merge_live_streak
  ON auto_merge_live_observation(repository, base_branch, category, merged_at DESC);
