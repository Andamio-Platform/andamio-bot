import { describe, it, expect } from 'vitest';

import { decodeJwtExpiryMs, isExpired } from './jwt';

/** Build a JWT-shaped string with the given payload (signature is irrelevant). */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature-ignored`;
}

describe('decodeJwtExpiryMs', () => {
  it('returns exp in milliseconds for a well-formed token', () => {
    const expSeconds = 1_900_000_000;
    expect(decodeJwtExpiryMs(makeJwt({ exp: expSeconds }))).toBe(
      expSeconds * 1000,
    );
  });

  it('returns null when the token has no exp claim', () => {
    expect(decodeJwtExpiryMs(makeJwt({ accessTokenAlias: 'alice' }))).toBeNull();
  });

  it('returns null when exp is not numeric', () => {
    expect(decodeJwtExpiryMs(makeJwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null for a non-JWT string (wrong segment count)', () => {
    expect(decodeJwtExpiryMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiryMs('only.two')).toBeNull();
  });

  it('returns null for a malformed payload segment', () => {
    expect(decodeJwtExpiryMs('header.@@notbase64json@@.sig')).toBeNull();
  });
});

describe('isExpired', () => {
  const now = 1_000_000_000_000;

  it('treats a null expiry as expired', () => {
    expect(isExpired(null, now)).toBe(true);
  });

  it('treats a past expiry as expired', () => {
    expect(isExpired(now - 1000, now)).toBe(true);
  });

  it('treats an expiry within the skew window as expired', () => {
    // 10s in the future is inside the 30s skew margin.
    expect(isExpired(now + 10 * 1000, now)).toBe(true);
  });

  it('treats a comfortably-future expiry as valid', () => {
    expect(isExpired(now + 60 * 60 * 1000, now)).toBe(false);
  });
});
