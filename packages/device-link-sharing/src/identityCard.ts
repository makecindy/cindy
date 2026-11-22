/**
 * Identity card verification (auth-server `POST /api/me/identity-card`).
 *
 * A card is an RS256 JWT signed with auth-server's access-token key and published
 * through the same JWKS. It carries only the caller's nickname and avatar plus the
 * binding claims needed here; device-link-server stores nothing else. Same region
 * trusts only the configured AUTH_ISSUER (P3 adds a separate, card-only peer issuer).
 */
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError, serviceUnavailable } from './errors.js';

export const IDENTITY_CARD_TYP = 'identity-card';
export const IDENTITY_CARD_AUDIENCE = 'cindy-provider-share';
/** auth-server signs exp = iat + 300; reject anything claiming a longer life. */
const IDENTITY_CARD_MAX_AGE_SEC = 300;
const CLOCK_TOLERANCE_SEC = 5;
const DISPLAY_NAME_MAX = 128;
const AVATAR_URL_MAX = 2048;
/** auth-server membership IDs; bounded so `x:<region>:<sub>` stays a valid identifier. */
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type IdentityCardPurpose = 'share-link' | 'share-request' | 'share-session';
export interface VerifiedPerson {
  displayName: string;
  avatarUrl: string | null;
  region: 'cn' | 'global';
}
export interface IdentityCardExpectation {
  purpose: IdentityCardPurpose;
  nonce: string;
  /** Same region: must equal the verified access-token subject (membershipId). */
  subject: string;
}
export interface VerifiedCard { subject: string; person: VerifiedPerson }
export interface IdentityCardVerifier {
  /** Throws PROVIDER_SHARE_IDENTITY_INVALID (400) or SERVICE_UNAVAILABLE when JWKS is down. */
  verify(card: string, expected: IdentityCardExpectation): Promise<VerifiedPerson>;
  /**
   * Cross-region: the subject is not known in advance, so it is returned for the caller
   * to derive `x:<region>:<sub>`. Purpose and nonce bindings are still enforced.
   */
  inspect(card: string, expected: Omit<IdentityCardExpectation, 'subject'>): Promise<VerifiedCard>;
}
export interface IdentityCardVerifierOptions {
  fetch?: typeof fetch;
  issuer: string;
  /** Remote JWKS URL, or an injected key resolver for tests. */
  keys: string | URL | JWTVerifyGetKey;
  clockToleranceSec?: number;
  /** Peer verifiers pin the card `region` claim to the configured peer region. */
  region?: 'cn' | 'global';
  /** Test clock in milliseconds. */
  now?: () => number;
}

export const identityInvalid = () => new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Identity card is invalid or expired');

function isJwksUnavailable(err: unknown): boolean {
  return err instanceof TypeError
    || err instanceof joseErrors.JWKSTimeout
    || err instanceof joseErrors.JWKSInvalid
    || (err instanceof joseErrors.JOSEError && err.code === 'ERR_JOSE_GENERIC');
}

/** Control characters are replaced, never shown to the other party. */
function displayName(value: unknown): string {
  if (typeof value !== 'string') throw identityInvalid();
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, DISPLAY_NAME_MAX).trim();
  if (!name) throw identityInvalid();
  return name;
}
/** Only https avatars are kept; anything else degrades to "no avatar". */
function avatarUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > AVATAR_URL_MAX) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function createIdentityCardVerifier(options: IdentityCardVerifierOptions): IdentityCardVerifier {
  let issuer = options.issuer;
  while (issuer.endsWith('/')) issuer = issuer.slice(0, -1);
  const keys = typeof options.keys === 'function'
    ? options.keys
    : createRemoteJWKSet(new URL(options.keys), { cacheMaxAge: 300_000, ...(options.fetch ? { [customFetch]: options.fetch } : {}) });
  const clockTolerance = options.clockToleranceSec ?? CLOCK_TOLERANCE_SEC;
  async function check(card: string, expected: Omit<IdentityCardExpectation, 'subject'>): Promise<VerifiedCard> {
    let payload;
    try {
      ({ payload } = await jwtVerify(card, keys, {
        issuer,
        audience: IDENTITY_CARD_AUDIENCE,
        algorithms: ['RS256'],
        clockTolerance,
        maxTokenAge: IDENTITY_CARD_MAX_AGE_SEC,
        requiredClaims: ['sub', 'iat', 'exp'],
        ...(options.now ? { currentDate: new Date(options.now()) } : {}),
      }));
    } catch (err) {
      if (isJwksUnavailable(err)) throw serviceUnavailable('Identity card keys are temporarily unavailable');
      throw identityInvalid();
    }
    if (
      payload.typ !== IDENTITY_CARD_TYP
      || payload.purpose !== expected.purpose
      || payload.nonce !== expected.nonce
      || typeof payload.sub !== 'string' || !SUBJECT.test(payload.sub)
      || typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
      || payload.exp - payload.iat > IDENTITY_CARD_MAX_AGE_SEC
      || (payload.region !== 'cn' && payload.region !== 'global')
      || (options.region !== undefined && payload.region !== options.region)
    ) {
      throw identityInvalid();
    }
    return {
      subject: payload.sub,
      person: { displayName: displayName(payload.name), avatarUrl: avatarUrl(payload.picture), region: payload.region },
    };
  }
  return {
    async verify(card, expected) {
      const verified = await check(card, expected);
      if (verified.subject !== expected.subject) throw identityInvalid();
      return verified.person;
    },
    inspect: check,
  };
}
