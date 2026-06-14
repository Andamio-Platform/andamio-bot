import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type Db } from './index';
import {
  upsertLink,
  getLinkByDiscordId,
  getLinkByAlias,
  deleteLink,
  createPending,
  getPendingByState,
  deletePending,
} from './links';

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
