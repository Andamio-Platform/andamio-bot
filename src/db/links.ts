import type { Db } from './index';

/** A persisted Discord-id ↔ Andamio-alias link. */
export interface Link {
  discord_id: string;
  alias: string;
  /** Reserved/unused: end-user JWTs have no unattended refresh, so this is always null. */
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

/**
 * Clear every stored user JWT that expires at or before `cutoffMs` (epoch ms),
 * keeping the link itself. A cleared token reads the same as an expired one
 * (`isExpired(null)` is true), so the member keeps getting the reconnect
 * prompt. A token with no recorded expiry is unusable and is cleared too.
 * Returns the number of links cleared.
 */
export function clearExpiredJwts(db: Db, cutoffMs: number): number {
  return db
    .prepare(
      `UPDATE links SET user_jwt = NULL, jwt_expires_at = NULL
       WHERE (user_jwt IS NOT NULL OR jwt_expires_at IS NOT NULL)
         AND (jwt_expires_at IS NULL OR jwt_expires_at <= ?)`,
    )
    .run(cutoffMs).changes;
}

/**
 * Delete everything the bot keeps for a member who has left the server: their
 * link and any pending logins. Deny-list rows are kept on purpose, so a blocked
 * member can't leave and rejoin to get the role back.
 */
export function deleteMemberData(db: Db, discordId: string): void {
  db.transaction((d: string) => {
    db.prepare(`DELETE FROM links WHERE discord_id = ?`).run(d);
    db.prepare(`DELETE FROM pending_logins WHERE discord_id = ?`).run(d);
  })(discordId);
}

// --- pending logins -----------------------------------------------------

/**
 * Record a pending login keyed by `state`, with the invoking Discord id.
 * `created_at` is set to the current epoch-ms.
 *
 * Any prior pending row for the same Discord id is deleted first: a member only
 * ever needs one live login URL, and starting a new login invalidates the old
 * one. This bounds the table to one row per in-flight member, so repeatedly
 * triggering the Connect button (e.g. an expired-JWT member running `/check`)
 * cannot accumulate orphaned rows.
 */
export function createPending(db: Db, state: string, discordId: string): void {
  // Atomic delete-then-insert so the "one live login per member" invariant
  // holds even under a future multi-process deployment.
  const tx = db.transaction((s: string, d: string) => {
    db.prepare(`DELETE FROM pending_logins WHERE discord_id = ?`).run(d);
    db.prepare(
      `INSERT INTO pending_logins (state, discord_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(s, d, Date.now());
  });
  tx(state, discordId);
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

/**
 * Delete pending logins created before `cutoffMs` (epoch ms): logins the member
 * started but never finished, which can no longer be completed. A row with no
 * `created_at` can never pass the TTL check either, so it goes too. Returns the
 * number of rows deleted.
 */
export function deleteStalePending(db: Db, cutoffMs: number): number {
  return db
    .prepare(
      `DELETE FROM pending_logins WHERE created_at IS NULL OR created_at < ?`,
    )
    .run(cutoffMs).changes;
}
