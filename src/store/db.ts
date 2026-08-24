import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { repairAnthropicAuthFailures, repairCodexCompletedTimeouts } from './run-repairs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.AUTO_DEV_DB_PATH ?? './data/auto-dev.db';
mkdirSync(dirname(dbPath), { recursive: true });

const db: DatabaseType = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// 기존 DB에 신규 컬럼 마이그레이션 (ADD COLUMN은 IF NOT EXISTS 미지원 → try/catch)
for (const col of [
  'ALTER TABLE agent_run ADD COLUMN error_type TEXT',
  'ALTER TABLE agent_run ADD COLUMN stop_reason TEXT',
  'ALTER TABLE agent_run ADD COLUMN num_turns INTEGER DEFAULT 0',
  'ALTER TABLE agent_run ADD COLUMN clarification_state TEXT',
  'ALTER TABLE agent_run ADD COLUMN model_id TEXT',
  'ALTER TABLE agent_run ADD COLUMN spec_session_id TEXT',
]) {
  try { db.exec(col); } catch { /* 이미 존재 */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_run_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_run(id) ON DELETE CASCADE
  )
`);
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_event_run ON agent_run_event(run_id, id)');
} catch { /* already exists */ }
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_spec_session ON agent_run(spec_session_id)');
} catch { /* already exists */ }

// clarification 답변/후속 지시로 이어진 과거 spec run에도 같은 세션 ID를 복원한다.
// trigger_detail에는 parent run UUID의 앞 8자가 기록돼 있다.
const specParents = db.prepare(`
  SELECT id, trigger_detail, spec_session_id
  FROM agent_run
  WHERE agent_name = 'spec' AND workflow_run_id IS NULL
  ORDER BY started_at ASC, id ASC
`).all() as Array<{ id: string; trigger_detail?: string; spec_session_id?: string }>;
const seenSpecParents = new Map<string, { id: string; sessionId: string }>();
const setSpecSession = db.prepare('UPDATE agent_run SET spec_session_id = ? WHERE id = ?');
for (const row of specParents) {
  const prefix = row.trigger_detail?.match(/^(?:answers|continue|resume):([0-9a-f]{8})/i)?.[1]?.toLowerCase();
  const parent = prefix
    ? [...seenSpecParents.values()].reverse().find((candidate) => candidate.id.toLowerCase().startsWith(prefix))
    : undefined;
  const sessionId = row.spec_session_id || parent?.sessionId || row.id;
  if (row.spec_session_id !== sessionId) setSpecSession.run(sessionId, row.id);
  seenSpecParents.set(row.id, { id: row.id, sessionId });
}
db.exec(`
  UPDATE agent_run
  SET spec_session_id = (
    SELECT parent.spec_session_id
    FROM agent_run AS parent
    WHERE parent.id = agent_run.workflow_run_id
  )
  WHERE workflow_run_id IS NOT NULL
    AND spec_session_id IS NULL
`);

// 서버 시작 시 RUNNING 상태로 남은 고아 레코드를 FAILED로 정리
db.prepare(`
  UPDATE agent_run
  SET status = 'FAILED', output = '[server_restart] 서버 재시작으로 중단됨', error_type = 'server_restart'
  WHERE status = 'RUNNING'
`).run();

// 일부 Claude SDK 버전이 result success로 반환한 과거 비로그인 실행을 교정한다.
repairAnthropicAuthFailures(db);
repairCodexCompletedTimeouts(db);

export { db };
