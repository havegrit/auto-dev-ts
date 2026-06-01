import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.AUTO_DEV_DB_PATH ?? './data/auto-dev.db';
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

export { db };
