import type { Db } from './index';

/** A persisted Discord-id ↔ Andamio-alias link. */
export interface Link {
  discord_id: string;
  alias: string;
  refresh_token: string | null;
  /** The member's Andamio user JWT, sent as the dashboard `Authorization: Bearer`. */
  user_jwt: string | null;
  /** Expiry of `user_jwt` in epoch MILLISECONDS (from the JWT `exp` claim). */
  jwt_expires_at: number | null;
  updated_at: number;
}

/** A pending login awaiting its callback, keyed by the high-entropy state. */
export interface PendingLogin {
  state: string;
  discord_id: string;
  created_at: number;
}

// --- links --------------------------------------------------------------

/**
 * Insert or update the link for a Discord id. Re-running `/login` overwrites
 * the existing row (alias, user JWT, and expiry are refreshed). `updated_at`
 * is set to the current epoch-ms.
 */
export function upsertLink(
  db: Db,
  discordId: string,
  alias: string,
  refreshToken: string | null = null,
  userJwt: string | null = null,
  jwtExpiresAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO links (discord_id, alias, refresh_token, user_jwt, jwt_expires_at, updated_at)
     VALUES (@discord_id, @alias, @refresh_token, @user_jwt, @jwt_expires_at, @updated_at)
     ON CONFLICT(discord_id) DO UPDATE SET
       alias = excluded.alias,
       refresh_token = excluded.refresh_token,
       user_jwt = excluded.user_jwt,
       jwt_expires_at = excluded.jwt_expires_at,
       updated_at = excluded.updated_at`,
  ).run({
    discord_id: discordId,
    alias,
    refresh_token: refreshToken,
    user_jwt: userJwt,
    jwt_expires_at: jwtExpiresAt,
    updated_at: Date.now(),
  });
}

/** Return the link for a Discord id, or null if none exists. */
export function getLinkByDiscordId(db: Db, discordId: string): Link | null {
  const row = db
    .prepare(`SELECT * FROM links WHERE discord_id = ?`)
    .get(discordId) as Link | undefined;
  return row ?? null;
}

/** Return all links, oldest-updated first. Used by the periodic gating sweep. */
export function getAllLinks(db: Db): Link[] {
  return db
    .prepare(`SELECT * FROM links ORDER BY updated_at ASC`)
    .all() as Link[];
}

/** Return the (first) link for an alias, or null if none exists. */
export function getLinkByAlias(db: Db, alias: string): Link | null {
  const row = db
    .prepare(`SELECT * FROM links WHERE alias = ?`)
    .get(alias) as Link | undefined;
  return row ?? null;
}

/** Delete the link for a Discord id. No-op if it does not exist. */
export function deleteLink(db: Db, discordId: string): void {
  db.prepare(`DELETE FROM links WHERE discord_id = ?`).run(discordId);
}

// --- pending logins -----------------------------------------------------

/**
 * Record a pending login keyed by `state`, with the invoking Discord id.
 * `created_at` is set to the current epoch-ms.
 */
export function createPending(db: Db, state: string, discordId: string): void {
  db.prepare(
    `INSERT INTO pending_logins (state, discord_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(state, discordId, Date.now());
}

/** Return the pending login for a state, or null if none exists. */
export function getPendingByState(db: Db, state: string): PendingLogin | null {
  const row = db
    .prepare(`SELECT * FROM pending_logins WHERE state = ?`)
    .get(state) as PendingLogin | undefined;
  return row ?? null;
}

/** Delete the pending login for a state. No-op if it does not exist. */
export function deletePending(db: Db, state: string): void {
  db.prepare(`DELETE FROM pending_logins WHERE state = ?`).run(state);
}
