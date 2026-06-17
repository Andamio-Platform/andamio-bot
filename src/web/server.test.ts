import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, type Db } from '../db/index';
import {
  deleteLink,
  getLinkByDiscordId,
  upsertLink,
} from '../db/links';
import { startLogin } from '../andamio/login';
import { createCallbackServer, handleCallback } from './server';

function callbackQuery(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

describe('handleCallback', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('AE1: valid callback with matching state stores discord_id ↔ alias + JWT and shows success', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');

    const expSeconds = 1_900_000_000;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
      'base64url',
    );
    const jwt = `${header}.${body}.sig`;

    const res = handleCallback(
      db,
      callbackQuery({ state, alias: 'alice', jwt, user_id: 'u1' }),
    );

    expect(res.status).toBe(200);
    expect(res.linkedDiscordId).toBe('discord-1');
    expect(res.html).toContain('connected');
    expect(res.html).toContain('alice');

    const link = getLinkByDiscordId(db, 'discord-1');
    expect(link?.alias).toBe('alice');
    // The user JWT is now persisted (it is the dashboard Bearer), with its
    // decoded expiry in epoch-ms.
    expect(link?.user_jwt).toBe(jwt);
    expect(link?.jwt_expires_at).toBe(expSeconds * 1000);
  });

  it('callback with a malformed jwt still links (alias stored, JWT null)', () => {
    const { state } = startLogin(db, 'discord-2', 'https://a', 'https://b');

    const res = handleCallback(
      db,
      callbackQuery({ state, alias: 'bob', jwt: 'not-a-jwt', user_id: 'u2' }),
    );

    expect(res.status).toBe(200);
    const link = getLinkByDiscordId(db, 'discord-2');
    expect(link?.alias).toBe('bob');
    expect(link?.user_jwt).toBe('not-a-jwt');
    // Malformed token → no decodable expiry, so reads will prompt a reconnect.
    expect(link?.jwt_expires_at).toBeNull();
  });

  it('rejects an unknown state, writes no link', () => {
    const res = handleCallback(
      db,
      callbackQuery({ state: 'never-issued', alias: 'alice', jwt: 'x' }),
    );
    expect(res.status).toBe(400);
    expect(res.linkedDiscordId).toBeUndefined();
    expect(res.html).toContain('invalid or has already been used');
    expect(getLinkByDiscordId(db, 'discord-1')).toBeNull();
  });

  it('rejects an expired state, writes no link', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');
    // Force expiry by aging the pending row past the TTL.
    db.prepare('UPDATE pending_logins SET created_at = ? WHERE state = ?').run(
      Date.now() - 60 * 60 * 1000,
      state,
    );

    const res = handleCallback(
      db,
      callbackQuery({ state, alias: 'alice', jwt: 'x' }),
    );
    expect(res.status).toBe(400);
    expect(res.html).toContain('expired');
    expect(getLinkByDiscordId(db, 'discord-1')).toBeNull();
  });

  it('rejects a replayed (already-consumed) state', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');

    const first = handleCallback(
      db,
      callbackQuery({ state, alias: 'alice', jwt: 'x' }),
    );
    expect(first.status).toBe(200);

    // Replay the exact same callback.
    const replay = handleCallback(
      db,
      callbackQuery({ state, alias: 'alice', jwt: 'x' }),
    );
    expect(replay.status).toBe(400);
    expect(replay.linkedDiscordId).toBeUndefined();
    expect(replay.html).toContain('invalid or has already been used');
  });

  it('callback missing alias → clear "no access token" message, no partial write', () => {
    const { state } = startLogin(db, 'discord-1', 'https://a', 'https://b');

    const res = handleCallback(db, callbackQuery({ state, jwt: 'x', user_id: 'u1' }));
    expect(res.status).toBe(400);
    expect(res.linkedDiscordId).toBeUndefined();
    expect(res.html).toContain('No access token found');
    expect(getLinkByDiscordId(db, 'discord-1')).toBeNull();
  });

  it('missing state is rejected', () => {
    const res = handleCallback(db, callbackQuery({ alias: 'alice', jwt: 'x' }));
    expect(res.status).toBe(400);
    expect(res.html).toContain('missing its');
  });
});

describe('createCallbackServer', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function request(
    server: ReturnType<typeof createCallbackServer>,
    pathAndQuery: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      server.listen(0, async () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('no address'));
          return;
        }
        try {
          const r = await fetch(
            `http://127.0.0.1:${addr.port}${pathAndQuery}`,
          );
          const body = await r.text();
          resolve({ status: r.status, body });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  it('serves GET /callback and fires the reevaluate hook on success', async () => {
    const reevaluate = vi.fn();
    const { state } = startLogin(db, 'discord-9', 'https://a', 'https://b');
    const server = createCallbackServer({ db, reevaluate });

    const res = await request(
      server,
      `/callback?state=${encodeURIComponent(state)}&alias=zoe&jwt=p`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('connected');
    expect(getLinkByDiscordId(db, 'discord-9')?.alias).toBe('zoe');
    // Allow the fire-and-forget hook to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(reevaluate).toHaveBeenCalledWith('discord-9');
  });

  it('returns 404 for unknown paths', async () => {
    const server = createCallbackServer({ db });
    const res = await request(server, '/nope');
    expect(res.status).toBe(404);
  });
});

describe('/logout link removal (command contract)', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('removes the link so the user is no longer connected', () => {
    upsertLink(db, 'discord-1', 'alice');
    expect(getLinkByDiscordId(db, 'discord-1')).not.toBeNull();

    // What /logout does for a connected user.
    deleteLink(db, 'discord-1');

    expect(getLinkByDiscordId(db, 'discord-1')).toBeNull();
  });
});
