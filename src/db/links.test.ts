import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, migrate, type Db } from './index';
import {
  upsertLink,
  getLinkByDiscordId,
  getLinkByAlias,
  deleteLink,
  createPending,
  getPendingByState,
  deletePending,
  clearExpiredJwts,
  deleteMemberData,
  deleteStalePending,
} from './links';
import { upsertDenial, listDenials } from './denials';

describe('db migration', () => {
  it('creates the schema and is idempotent (running twice does not error)', () => {
    const db: Db = openDb(':memory:');
    // openDb already migrated once; a second + third call must be no-ops.
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('links');
    expect(tables).toContain('pending_logins');
    db.close();
  });

  it('upgrades an older links table by adding the JWT columns, preserving rows', () => {
    // Simulate a database created before the JWT columns existed.
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE links (
        discord_id    TEXT PRIMARY KEY,
        alias         TEXT NOT NULL,
        refresh_token TEXT,
        updated_at    INTEGER
      );
    `);
    raw
      .prepare(
        `INSERT INTO links (discord_id, alias, refresh_token, updated_at) VALUES (?,?,?,?)`,
      )
      .run('d1', 'alice', null, 123);

    migrate(raw as Db);

    const cols = (
      raw.prepare(`PRAGMA table_info(links)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('user_jwt');
    expect(cols).toContain('jwt_expires_at');

    // Existing row is preserved; new columns default to null.
    const row = raw
      .prepare(`SELECT * FROM links WHERE discord_id = ?`)
      .get('d1') as { alias: string; user_jwt: string | null };
    expect(row.alias).toBe('alice');
    expect(row.user_jwt).toBeNull();

    // Re-running the migration is a no-op (no duplicate-column error).
    expect(() => migrate(raw as Db)).not.toThrow();
    raw.close();
  });
});

describe('links accessors', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('upsert then get-by-discord-id returns the row', () => {
    upsertLink(db, 'discord-1', 'alice', 'refresh-xyz');
    const link = getLinkByDiscordId(db, 'discord-1');
    expect(link).not.toBeNull();
    expect(link?.discord_id).toBe('discord-1');
    expect(link?.alias).toBe('alice');
    expect(link?.refresh_token).toBe('refresh-xyz');
    expect(typeof link?.updated_at).toBe('number');
  });

  it('upsert with no refresh token stores null', () => {
    upsertLink(db, 'discord-2', 'bob');
    const link = getLinkByDiscordId(db, 'discord-2');
    expect(link?.refresh_token).toBeNull();
  });

  it('persists the user JWT and its expiry', () => {
    upsertLink(db, 'discord-5', 'eve', null, 'jwt.value.x', 1_234_567);
    const link = getLinkByDiscordId(db, 'discord-5');
    expect(link?.user_jwt).toBe('jwt.value.x');
    expect(link?.jwt_expires_at).toBe(1_234_567);
  });

  it('upsert on an existing discord id overwrites alias and refresh token', () => {
    upsertLink(db, 'discord-1', 'alice', 'old-token');
    upsertLink(db, 'discord-1', 'alice-renamed', 'new-token');
    const link = getLinkByDiscordId(db, 'discord-1');
    expect(link?.alias).toBe('alice-renamed');
    expect(link?.refresh_token).toBe('new-token');
    // Still exactly one row for this discord id.
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM links WHERE discord_id = ?`)
      .get('discord-1') as { n: number };
    expect(count.n).toBe(1);
  });

  it('get-by-alias returns the matching link', () => {
    upsertLink(db, 'discord-3', 'carol');
    const link = getLinkByAlias(db, 'carol');
    expect(link?.discord_id).toBe('discord-3');
  });

  it('get-by-unknown-alias returns null', () => {
    expect(getLinkByAlias(db, 'nobody')).toBeNull();
  });

  it('get-by-unknown-discord-id returns null', () => {
    expect(getLinkByDiscordId(db, 'ghost')).toBeNull();
  });

  it('delete removes the link', () => {
    upsertLink(db, 'discord-4', 'dave');
    expect(getLinkByDiscordId(db, 'discord-4')).not.toBeNull();
    deleteLink(db, 'discord-4');
    expect(getLinkByDiscordId(db, 'discord-4')).toBeNull();
  });

  it('delete on an unknown discord id is a no-op', () => {
    expect(() => deleteLink(db, 'never-existed')).not.toThrow();
  });
});

describe('pending-login helpers', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('create then get-by-state returns the pending login', () => {
    createPending(db, 'state-abc', 'discord-1');
    const pending = getPendingByState(db, 'state-abc');
    expect(pending).not.toBeNull();
    expect(pending?.state).toBe('state-abc');
    expect(pending?.discord_id).toBe('discord-1');
    expect(typeof pending?.created_at).toBe('number');
  });

  it('get-by-unknown-state returns null', () => {
    expect(getPendingByState(db, 'missing')).toBeNull();
  });

  it('delete removes the pending login (state cannot be replayed)', () => {
    createPending(db, 'state-xyz', 'discord-2');
    deletePending(db, 'state-xyz');
    expect(getPendingByState(db, 'state-xyz')).toBeNull();
  });
});

describe('clearExpiredJwts', () => {
  let db: Db;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('clears an expired token but keeps the link', () => {
    upsertLink(db, 'd1', 'alice', null, 'h.p.s', NOW - 1);
    expect(clearExpiredJwts(db, NOW)).toBe(1);
    const link = getLinkByDiscordId(db, 'd1');
    expect(link).toMatchObject({ alias: 'alice', user_jwt: null, jwt_expires_at: null });
  });

  it('clears a token expiring exactly at the cutoff', () => {
    upsertLink(db, 'd1', 'alice', null, 'h.p.s', NOW);
    expect(clearExpiredJwts(db, NOW)).toBe(1);
    expect(getLinkByDiscordId(db, 'd1')?.user_jwt).toBeNull();
  });

  it('leaves a not-yet-expired token untouched', () => {
    upsertLink(db, 'd1', 'alice', null, 'h.p.s', NOW + 60_000);
    expect(clearExpiredJwts(db, NOW)).toBe(0);
    expect(getLinkByDiscordId(db, 'd1')).toMatchObject({
      user_jwt: 'h.p.s',
      jwt_expires_at: NOW + 60_000,
    });
  });

  it('is a no-op on an already-cleared token', () => {
    upsertLink(db, 'd1', 'alice', null, null, null);
    expect(clearExpiredJwts(db, NOW)).toBe(0);
    expect(getLinkByDiscordId(db, 'd1')).toMatchObject({
      alias: 'alice',
      user_jwt: null,
      jwt_expires_at: null,
    });
  });

  it('clears a token with no recorded expiry (unusable)', () => {
    upsertLink(db, 'd1', 'alice', null, 'h.p.s', null);
    expect(clearExpiredJwts(db, NOW)).toBe(1);
    expect(getLinkByDiscordId(db, 'd1')?.user_jwt).toBeNull();
  });

  it('only clears the expired links among several', () => {
    upsertLink(db, 'd1', 'alice', null, 'old', NOW - 1);
    upsertLink(db, 'd2', 'bob', null, 'new', NOW + 60_000);
    expect(clearExpiredJwts(db, NOW)).toBe(1);
    expect(getLinkByDiscordId(db, 'd1')?.user_jwt).toBeNull();
    expect(getLinkByDiscordId(db, 'd2')?.user_jwt).toBe('new');
  });
});

describe('deleteMemberData', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('deletes the link and pending logins but keeps denials', () => {
    upsertLink(db, 'd1', 'alice', null, 'h.p.s', Date.now() + 60_000);
    createPending(db, 'state-1', 'd1');
    upsertDenial(db, 'd1', 'r1', 'spam', 'mod-1');

    deleteMemberData(db, 'd1');

    expect(getLinkByDiscordId(db, 'd1')).toBeNull();
    expect(getPendingByState(db, 'state-1')).toBeNull();
    expect(listDenials(db, 'd1')).toHaveLength(1);
  });

  it("leaves other members' rows alone", () => {
    upsertLink(db, 'd1', 'alice');
    upsertLink(db, 'd2', 'bob');
    createPending(db, 'state-2', 'd2');

    deleteMemberData(db, 'd1');

    expect(getLinkByDiscordId(db, 'd2')).not.toBeNull();
    expect(getPendingByState(db, 'state-2')).not.toBeNull();
  });

  it('is a no-op for a member with no data', () => {
    expect(() => deleteMemberData(db, 'nobody')).not.toThrow();
  });
});

describe('deleteStalePending', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('deletes logins created before the cutoff and keeps newer ones', () => {
    createPending(db, 'old', 'd1');
    createPending(db, 'new', 'd2');
    db.prepare(`UPDATE pending_logins SET created_at = 1000 WHERE state = 'old'`).run();
    db.prepare(`UPDATE pending_logins SET created_at = 3000 WHERE state = 'new'`).run();

    expect(deleteStalePending(db, 2000)).toBe(1);
    expect(getPendingByState(db, 'old')).toBeNull();
    expect(getPendingByState(db, 'new')).not.toBeNull();
  });

  it('keeps a login created exactly at the cutoff', () => {
    createPending(db, 's', 'd1');
    db.prepare(`UPDATE pending_logins SET created_at = 2000`).run();
    expect(deleteStalePending(db, 2000)).toBe(0);
  });

  it('deletes a login with no created_at', () => {
    createPending(db, 's', 'd1');
    db.prepare(`UPDATE pending_logins SET created_at = NULL`).run();
    expect(deleteStalePending(db, 2000)).toBe(1);
  });
});
