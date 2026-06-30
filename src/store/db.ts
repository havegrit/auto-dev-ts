import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
]) {
  try { db.exec(col); } catch { /* 이미 존재 */ }
}

// 서버 시작 시 RUNNING 상태로 남은 고아 레코드를 FAILED로 정리
db.prepare(`
  UPDATE agent_run
  SET status = 'FAILED', output = '[server_restart] 서버 재시작으로 중단됨', error_type = 'server_restart'
  WHERE status = 'RUNNING'
`).run();

export { db };
