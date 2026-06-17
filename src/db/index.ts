import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type Db = Database.Database;

/**
 * Run the idempotent schema migration. Safe to call repeatedly: `CREATE TABLE
 * IF NOT EXISTS` no-ops on a second run, and the per-column upgrade below adds
 * the JWT columns only when an older `links` table predates them — so an
 * existing persisted database keeps its rows instead of being recreated.
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      discord_id     TEXT PRIMARY KEY,
      alias          TEXT NOT NULL,
      refresh_token  TEXT,
      user_jwt       TEXT,
      jwt_expires_at INTEGER,
      updated_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS pending_logins (
      state      TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      created_at INTEGER
    );
  `);

  // Upgrade databases created before the JWT columns existed. Additive and
  // idempotent — never drops or rewrites existing link rows.
  addColumnIfMissing(db, 'links', 'user_jwt', 'TEXT');
  addColumnIfMissing(db, 'links', 'jwt_expires_at', 'INTEGER');
}

/** Add `column` to `table` if it is not already present. */
function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
