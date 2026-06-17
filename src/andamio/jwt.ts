/**
 * Minimal, signature-agnostic JWT helpers.
 *
 * The bot never verifies a user JWT — the Andamio API does that on every call.
 * The bot only needs the `exp` claim to decide, locally, whether a stored token
 * is worth sending or whether to prompt the member to reconnect instead. So we
 * base64url-decode the payload segment and read `exp`; we do not validate the
 * signature.
 */

/** Skew (ms) treated as "already expired" to avoid sending a token that dies mid-flight. */
const EXPIRY_SKEW_MS = 30 * 1000;

/**
 * Decode a JWT's `exp` claim and return it as epoch MILLISECONDS (the time
 * convention used elsewhere in the DB), or null if the token is malformed or
 * carries no numeric `exp`.
 */
export function decodeJwtExpiryMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * True when a stored JWT should be treated as unusable: no expiry recorded, or
 * the expiry is within {@link EXPIRY_SKEW_MS} of now (or already past).
 */
export function isExpired(
  expiryMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (expiryMs === null) return true;
  return expiryMs <= nowMs + EXPIRY_SKEW_MS;
}
