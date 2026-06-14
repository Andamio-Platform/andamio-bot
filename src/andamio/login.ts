import * as crypto from 'crypto';

import type { Db } from '../db/index';
import {
  createPending,
  deletePending,
  getPendingByState,
  upsertLink,
  type PendingLogin,
} from '../db/links';

/** Default lifetime of a pending login before it is considered expired (ms). */
export const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Number of random bytes behind a `state` value (256 bits of entropy). */
const STATE_BYTES = 32;

/** Generate a high-entropy, URL-safe login `state`. */
export function generateState(): string {
  return crypto.randomBytes(STATE_BYTES).toString('base64url');
}

/**
 * Begin a login: generate a fresh `state`, record a pending login keyed by it
 * for the invoking Discord id, and build the hosted CLI auth URL the user opens
 * in their browser.
 *
 * The app authenticates the user and redirects (GET) back to
 * `${botCallbackBaseUrl}/callback?jwt=&state=&alias=&user_id=`.
 *
 * Re-running for the same Discord id is fine — each call mints a new `state`
 * (a new pending row); the eventual `upsertLink` overwrites any prior link.
 */
export function startLogin(
  db: Db,
  discordId: string,
  appLoginBaseUrl: string,
  botCallbackBaseUrl: string,
): { state: string; url: string } {
  const state = generateState();
  createPending(db, state, discordId);

  const redirectUri = `${botCallbackBaseUrl}/callback`;
  const url =
    `${appLoginBaseUrl}/auth/cli` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  return { state, url };
}

/** Why a pending login could not be consumed. */
export type ConsumeError = 'unknown' | 'expired';

export type ConsumeResult =
  | { ok: true; pending: PendingLogin }
  | { ok: false; error: ConsumeError };

/**
 * Validate and consume a pending login for `state`.
 *
 * - Unknown `state` (never issued, or already consumed/replayed) → `unknown`.
 * - Known but older than the TTL → `expired` (the pending row is deleted so a
 *   later replay is reported as `unknown` rather than lingering).
 * - Valid → returns the pending row and deletes it so the `state` is single-use.
 *
 * This never writes a link; the caller decides what to do once it has the
 * Discord id (e.g. requires a non-empty `alias` before linking).
 */
export function consumePending(
  db: Db,
  state: string,
  now: number = Date.now(),
  ttlMs: number = PENDING_TTL_MS,
): ConsumeResult {
  const pending = getPendingByState(db, state);
  if (!pending) {
    return { ok: false, error: 'unknown' };
  }

  if (now - pending.created_at > ttlMs) {
    deletePending(db, state);
    return { ok: false, error: 'expired' };
  }

  // Single-use: consume now so a replay of the same callback is rejected.
  deletePending(db, state);
  return { ok: true, pending };
}

/**
 * Persist a proven link. The user flow returns `alias` (no refresh token), so
 * the alias is the durable key; `refresh_token` is left null. The JWT is proof
 * only and is never persisted.
 */
export function storeLink(db: Db, discordId: string, alias: string): void {
  upsertLink(db, discordId, alias, null);
}
