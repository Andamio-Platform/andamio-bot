import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db/index';
import { getLinkByDiscordId, getPendingByState } from '../db/links';
import {
  PENDING_TTL_MS,
  consumePending,
  generateState,
  startLogin,
  storeLink,
} from './login';

describe('generateState', () => {
  it('produces high-entropy, url-safe, unique values', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    // base64url: no +, /, or = padding
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});

describe('startLogin', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('records a pending login and builds the auth URL with redirect_uri + state', () => {
    const { state, url } = startLogin(
      db,
      'discord-1',
      'https://app.andamio.io',
      'https://bot.example.com',
    );

    const pending = getPendingByState(db, state);
    expect(pending?.discord_id).toBe('discord-1');

    expect(url).toContain('https://app.andamio.io/auth/cli');
    expect(url).toContain(`state=${encodeURIComponent(state)}`);
    expect(url).toContain(
      `redirect_uri=${encodeURIComponent('https://bot.example.com/callback')}`,
    );
  });

  it('mints a distinct state on each call (re-login overwrites later)', () => {
    const first = startLogin(db, 'd', 'https://a', 'https://b');
    const second = startLogin(db, 'd', 'https://a', 'https://b');
    expect(first.state).not.toBe(second.state);
    expect(getPendingByState(db, first.state)).not.toBeNull();
    expect(getPendingByState(db, second.state)).not.toBeNull();
  });
});

describe('consumePending', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('returns the pending row for a valid state and consumes it (single-use)', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');
    const result = consumePending(db, state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pending.discord_id).toBe('discord-1');
    }
    // Consumed: a replay is now unknown.
    const replay = consumePending(db, state);
    expect(replay).toEqual({ ok: false, error: 'unknown' });
  });

  it('rejects an unknown state', () => {
    expect(consumePending(db, 'never-issued')).toEqual({
      ok: false,
      error: 'unknown',
    });
  });

  it('rejects an expired state and removes the pending row', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');
    const future = Date.now() + PENDING_TTL_MS + 1;
    expect(consumePending(db, state, future)).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(getPendingByState(db, state)).toBeNull();
  });
});

describe('storeLink', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('persists discord_id ↔ alias with no refresh token (alias is the key)', () => {
    storeLink(db, 'discord-1', 'alice');
    const link = getLinkByDiscordId(db, 'discord-1');
    expect(link?.alias).toBe('alice');
    expect(link?.refresh_token).toBeNull();
  });
});
