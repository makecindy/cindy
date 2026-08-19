import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  decodeJwtExpMs,
  decodeJwtOrgSlug,
  isAccessTokenExpiring,
} from '../jwt';

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeJwt(payload: object): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

const NOW = 1_700_000_000_000; // epoch ms == 1_700_000_000 s

describe('jwt helpers', () => {
  it('decodes a non-empty orgSlug claim', () => {
    expect(decodeJwtOrgSlug(makeJwt({ ctx: 'org', orgSlug: 'xd' }))).toBe('xd');
  });

  it('returns null for missing/invalid orgSlug or malformed tokens', () => {
    expect(decodeJwtOrgSlug(makeJwt({ sub: 'x' }))).toBeNull();
    expect(decodeJwtOrgSlug(makeJwt({ orgSlug: '' }))).toBeNull();
    expect(decodeJwtOrgSlug(makeJwt({ orgSlug: 42 }))).toBeNull();
    expect(decodeJwtOrgSlug('not-a-jwt')).toBeNull();
  });

  it('decodes a numeric exp (seconds) into epoch ms', () => {
    expect(decodeJwtExpMs(makeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  it('returns null for missing/non-numeric exp or malformed tokens', () => {
    expect(decodeJwtExpMs(makeJwt({ sub: 'x' }))).toBeNull();
    expect(decodeJwtExpMs(makeJwt({ exp: 'soon' }))).toBeNull();
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpMs('')).toBeNull();
  });

  it('flags tokens at/within the skew window as expiring', () => {
    expect(isAccessTokenExpiring(makeJwt({ exp: 1_700_000_020 }), NOW)).toBe(true); // 20s out < 30s skew
    expect(isAccessTokenExpiring(makeJwt({ exp: 1_699_999_990 }), NOW)).toBe(true); // already expired
  });

  it('treats a comfortably-future token as not expiring', () => {
    expect(isAccessTokenExpiring(makeJwt({ exp: 1_700_000_600 }), NOW)).toBe(false); // 10min out
  });

  it('does not force refresh when exp is unknown (REST 401-retry still covers it)', () => {
    expect(isAccessTokenExpiring(makeJwt({ sub: 'x' }), NOW)).toBe(false);
    expect(isAccessTokenExpiring('opaque', NOW)).toBe(false);
    expect(ACCESS_TOKEN_EXPIRY_SKEW_MS).toBeGreaterThan(0);
  });
});
