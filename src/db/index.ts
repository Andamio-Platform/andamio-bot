import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type Db = Database.Database;

/**
 * Run the idempotent schema migration. Safe to call repeatedly — uses
 * `CREATE TABLE IF NOT EXISTS`, so a second run is a no-op.
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      discord_id    TEXT PRIMARY KEY,
      alias         TEXT NOT NULL,
      refresh_token TEXT,
      updated_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS pending_logins (
      state      TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      created_at INTEGER
    );
  `);
}

/**
 * Open the SQLite database at `dbPath` and run migrations. Creates the parent
 * directory if needed. Pass `:memory:` for an ephemeral in-memory database.
 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
