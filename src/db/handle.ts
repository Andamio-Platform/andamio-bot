import type { Db } from './index';

/**
 * Process-wide shared database handle.
 *
 * Command modules export `{ data, execute }` and are loaded reflectively, so
 * they cannot receive the db by constructor injection. `index.ts` opens the db
 * once at boot and registers it here; commands read it via `getDb()`.
 */
let db: Db | null = null;

export function setDb(handle: Db): void {
  db = handle;
}

export function getDb(): Db {
  if (!db) {
    throw new Error('Database handle not initialised — call setDb() at startup');
  }
  return db;
}
