import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = resolve(process.env.AUTO_DEV_DB_PATH ?? './data/auto-dev.db');
const backupDir = resolve(process.env.AUTO_DEV_BACKUP_DIR ?? './data/backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = resolve(backupDir, `${basename(dbPath, '.db')}-${timestamp}.db`);

await mkdir(dirname(outputPath), { recursive: true });
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  await db.backup(outputPath);
  console.log(`SQLite backup created: ${outputPath}`);
} finally {
  db.close();
}
