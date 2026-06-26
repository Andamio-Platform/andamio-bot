import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type Db } from './index';
import {
  upsertDenial,
  deleteDenial,
  deleteAllDenials,
  getDeniedRoleIds,
  listDenials,
  FULL_BLOCK,
} from './denials';

describe('denials migration', () => {
  it('creates the denials table and is idempotent', () => {
    const db: Db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('denials');
    db.close();
  });
});

describe('denials accessor', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  const managed = new Set(['r1', 'r2', 'r3']);

  it('upsertDenial inserts a per-role denial', () => {
    upsertDenial(db, 'u1', 'r1', 'spamming', 'mod1');
    const rows = listDenials(db, 'u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      discord_id: 'u1',
      role_id: 'r1',
      reason: 'spamming',
      created_by: 'mod1',
    });
    expect(typeof rows[0].created_at).toBe('number');
  });

  it('re-denying the same (discord_id, role_id) upserts, not duplicates', () => {
    upsertDenial(db, 'u1', 'r1', 'first', 'mod1');
    upsertDenial(db, 'u1', 'r1', 'second', 'mod2');
    const rows = listDenials(db, 'u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('second');
    expect(rows[0].created_by).toBe('mod2');
  });

  it('getDeniedRoleIds returns exactly the per-role denial', () => {
    upsertDenial(db, 'u1', 'r2', null, 'mod1');
    expect(getDeniedRoleIds(db, 'u1', managed)).toEqual(new Set(['r2']));
  });

  it('getDeniedRoleIds expands the FULL_BLOCK sentinel to all managed roles', () => {
    upsertDenial(db, 'u1', FULL_BLOCK, 'full block', 'mod1');
    expect(getDeniedRoleIds(db, 'u1', managed)).toEqual(new Set(['r1', 'r2', 'r3']));
  });

  it('getDeniedRoleIds unions a full block with an extra (even unmanaged) role', () => {
    upsertDenial(db, 'u1', FULL_BLOCK, null, 'mod1');
    upsertDenial(db, 'u1', 'rX', null, 'mod1'); // rX not in managed
    expect(getDeniedRoleIds(db, 'u1', managed)).toEqual(
      new Set(['r1', 'r2', 'r3', 'rX']),
    );
  });

  it('getDeniedRoleIds is empty for a member with no denials', () => {
    expect(getDeniedRoleIds(db, 'nobody', managed)).toEqual(new Set());
  });

  it('deleteDenial removes one role and leaves the rest', () => {
    upsertDenial(db, 'u1', 'r1', null, 'mod1');
    upsertDenial(db, 'u1', 'r2', null, 'mod1');
    deleteDenial(db, 'u1', 'r1');
    expect(getDeniedRoleIds(db, 'u1', managed)).toEqual(new Set(['r2']));
  });

  it('deleteAllDenials clears every row for the member', () => {
    upsertDenial(db, 'u1', 'r1', null, 'mod1');
    upsertDenial(db, 'u1', FULL_BLOCK, null, 'mod1');
    deleteAllDenials(db, 'u1');
    expect(listDenials(db, 'u1')).toHaveLength(0);
  });

  it('listDenials with no id returns all members; with an id scopes to one', () => {
    upsertDenial(db, 'u1', 'r1', null, 'mod1');
    upsertDenial(db, 'u2', 'r2', null, 'mod1');
    expect(listDenials(db)).toHaveLength(2);
    expect(listDenials(db, 'u2')).toHaveLength(1);
    expect(listDenials(db, 'u2')[0].discord_id).toBe('u2');
  });
});
