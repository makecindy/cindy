/**
 * Google AI Ultra plan OAuth (RFC 9449 DPoP + PKCE + OIDC nonce).
 *
 * Google approves each application's `Desktop app` OAuth client separately and binds
 * refresh tokens to a per-machine P-256 ECDSA key pair via DPoP proofs. Inference calls
 * use the access token as a plain Bearer token without DPoP.
 *
 * Pure Node/WebCrypto module (no Electron or node:http imports) shared by Desktop and
 * Node Host (`apps/host`). Outbound requests always use the caller-supplied `fetchImpl`.
 */

import { randomBytes } from 'node:crypto';

export const GOOGLE_AI_PLAN_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_AI_PLAN_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AI_PLAN_QUOTA_SCOPE =
  'https://www.googleapis.com/auth/generative-language.peruserquota';
export const GOOGLE_AI_PLAN_SCOPES = `openid email profile ${GOOGLE_AI_PLAN_QUOTA_SCOPE}`;
export const GOOGLE_AI_PLAN_CALLBACK_PATH = '/oauth2callback';
/** Long enough to finish a Google AI Ultra upgrade checkout in the browser. */
export const GOOGLE_AI_PLAN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Google partner docs ask clients to refresh 5 minutes before access-token expiry. */
export const GOOGLE_AI_PLAN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const GOOGLE_AI_PLAN_CLIENT_ID_ENV = 'CINDY_GOOGLE_AI_PLAN_CLIENT_ID';
export const GOOGLE_AI_PLAN_CLIENT_SECRET_ENV = 'CINDY_GOOGLE_AI_PLAN_CLIENT_SECRET';
export const GOOGLE_AI_PLAN_CLIENT_PLACEHOLDER_ID = 'cindy-google-ai-plan';

/**
 * Defense-in-depth denylist:
 * - Pi's client is approved by Google for Pi only and must never be reused by Cindy.
 * - Cindy's Workspace plugin client (Gmail/Calendar/Drive/Sheets) must stay isolated
 *   from AI Ultra quota verification.
 */
const DISALLOWED_GOOGLE_AI_PLAN_CLIENT_IDS = new Set([
  '1023131902207-qip7ip8p3hl0hi4cptjkv2dkigkt03om.apps.googleusercontent.com',
  '948713214926-onmd8lp4prlfl78qppbfjpl568mc504r.apps.googleusercontent.com',
]);

export interface GoogleAiPlanClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Built-in Cindy `Desktop app` OAuth client once approved by Google for
 * `generative-language.peruserquota`. Kept `null` until approval is granted;
 * local testing and verification video recording inject credentials via
 * `CINDY_GOOGLE_AI_PLAN_CLIENT_ID` and `CINDY_GOOGLE_AI_PLAN_CLIENT_SECRET`.
 */
export const CINDY_GOOGLE_AI_PLAN_APPROVED_CLIENT: GoogleAiPlanClient | null = null;

/**
 * P-256 private JWK persisted inside safeStorage alongside the OAuth blob.
 * Only public fields (`kty`, `crv`, `x`, `y`) are placed in the DPoP JWT header;
 * WebCrypto's `ext` and `key_ops` fields are stripped because Google rejects them.
 */
export interface GoogleAiPlanDpopKey {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleAiPlanExchangeResult {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  identity?: string;
  dpopKey: GoogleAiPlanDpopKey;
}

export type GoogleAiPlanRefreshResult =
  | {
      ok: true;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      dpopNonce?: string;
    }
  | {
      ok: false;
      terminal: boolean;
      status: number;
      error: string;
    };

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');
}

export function generateGoogleAiPlanNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function resolveGoogleAiPlanOAuthClient(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleAiPlanClient {
  const envClientId = env[GOOGLE_AI_PLAN_CLIENT_ID_ENV]?.trim();
  const envClientSecret = env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV]?.trim();
  const candidate =
    envClientId || envClientSecret
      ? { clientId: envClientId ?? '', clientSecret: envClientSecret ?? '' }
      : CINDY_GOOGLE_AI_PLAN_APPROVED_CLIENT;

  if (!candidate || !candidate.clientId || !candidate.clientSecret) {
    throw new Error(
      `Google AI Ultra OAuth client is not configured. Set ${GOOGLE_AI_PLAN_CLIENT_ID_ENV} and ${GOOGLE_AI_PLAN_CLIENT_SECRET_ENV} with Cindy's Google-approved Desktop app OAuth credentials.`,
    );
  }
  if (candidate.clientId === GOOGLE_AI_PLAN_CLIENT_PLACEHOLDER_ID) {
    throw new Error(
      `Google AI Ultra OAuth client is using a placeholder client ID. Set ${GOOGLE_AI_PLAN_CLIENT_ID_ENV} and ${GOOGLE_AI_PLAN_CLIENT_SECRET_ENV}.`,
    );
  }
  if (DISALLOWED_GOOGLE_AI_PLAN_CLIENT_IDS.has(candidate.clientId)) {
    throw new Error(
      'Google AI Ultra OAuth requires a dedicated Cindy Desktop app OAuth client; do not reuse Pi or Cindy Workspace plugin credentials.',
    );
  }
  return candidate;
}

export async function createGoogleAiPlanDpopKey(): Promise<GoogleAiPlanDpopKey> {
  const { privateKey } = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const { kty, crv, x, y, d } = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
  if (!kty || !crv || !x || !y || !d) {
    throw new Error('Failed to export Google AI Ultra DPoP key');
  }
  return { kty, crv, x, y, d };
}

export function parseGoogleAiPlanDpopKey(value: unknown): GoogleAiPlanDpopKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const { kty, crv, x, y, d } = candidate;
  if (
    kty !== 'EC' ||
    crv !== 'P-256' ||
    typeof x !== 'string' ||
    !x ||
    typeof y !== 'string' ||
    !y ||
    typeof d !== 'string' ||
    !d
  ) {
    return null;
  }
  return { kty, crv, x, y, d };
}

/**
 * Sign an RFC 9449 DPoP proof for Google's token endpoint.
 * WebCrypto produces raw R||S (64-byte) ECDSA signatures, which Google requires
 * (ASN.1 DER signatures are rejected).
 */
export async function createGoogleAiPlanDpopProof(
  key: GoogleAiPlanDpopKey,
  claims: { jti: string; nonce?: string; iat?: number },
  tokenUrl = GOOGLE_AI_PLAN_TOKEN_URL,
  nowMs: () => number = Date.now,
): Promise<string> {
  const { kty, crv, x, y } = key;
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } };
  const iat = claims.iat ?? Math.floor(nowMs() / 1000);
  const payload = {
    jti: claims.jti,
    ...(claims.nonce !== undefined ? { nonce: claims.nonce } : {}),
    htm: 'POST',
    htu: tokenUrl,
    iat,
  };
  const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signingKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(input),
  );
  return `${input}.${base64url(signature)}`;
}

/** Validate OIDC ID token claims (`iss`, `aud`, `nonce`, `exp`) per OpenID Connect Core 3.1.3.7. */
export function validateGoogleAiPlanIdToken(
  idToken: string | undefined,
  expectedNonce: string,
  clientId: string,
  nowMs = Date.now(),
): { email?: string; name?: string } {
  if (!idToken) throw new Error('Google sign-in returned no ID token');
  const payloadSegment = idToken.split('.')[1];
  if (!payloadSegment) throw new Error('Google sign-in returned a malformed ID token');
  let claims: {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    nonce?: unknown;
    email?: unknown;
    name?: unknown;
  };
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    throw new Error('Google sign-in returned an unreadable ID token');
  }
  const issuerOk =
    claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const notExpired = exp * 1000 > nowMs - 60_000;
  if (!issuerOk || claims.aud !== clientId || claims.nonce !== expectedNonce || !notExpired) {
    throw new Error('Google sign-in returned an ID token that failed validation');
  }
  return {
    ...(typeof claims.email === 'string' && claims.email ? { email: claims.email } : {}),
    ...(typeof claims.name === 'string' && claims.name ? { name: claims.name } : {}),
  };
}

async function postGoogleToken(params: {
  tokenUrl: string;
  client: GoogleAiPlanClient;
  form: Record<string, string>;
  dpop: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<{
  status: number;
  body: GoogleTokenResponse;
  nonce?: string;
  serverTime?: number;
}> {
  const response = await params.fetchImpl(params.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      DPoP: params.dpop,
    },
    body: new URLSearchParams({
      ...params.form,
      client_id: params.client.clientId,
      client_secret: params.client.clientSecret,
    }).toString(),
    signal: params.signal,
  });
  const text = await response.text().catch(() => '');
  let body: GoogleTokenResponse;
  try {
    const parsed = JSON.parse(text) as unknown;
    body =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as GoogleTokenResponse)
        : { error: `HTTP ${response.status}`, error_description: text.slice(0, 200) };
  } catch {
    body = { error: `HTTP ${response.status}`, error_description: text.slice(0, 200) };
  }
  const dateHeader = response.headers.get('date');
  const parsedDate = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return {
    status: response.status,
    body,
    nonce: response.headers.get('dpop-nonce') ?? undefined,
    serverTime: Number.isNaN(parsedDate) ? undefined : Math.floor(parsedDate / 1000),
  };
}

function describeGoogleTokenError(prefix: string, status: number, body: GoogleTokenResponse): string {
  return `${prefix}: ${status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim();
}

export async function exchangeGoogleAiPlanCode(params: {
  tokenUrl?: string;
  client: GoogleAiPlanClient;
  code: string;
  verifier: string;
  redirectUri: string;
  expectedNonce: string;
  dpopKey: GoogleAiPlanDpopKey;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  now?: () => number;
}): Promise<GoogleAiPlanExchangeResult> {
  const tokenUrl = params.tokenUrl ?? GOOGLE_AI_PLAN_TOKEN_URL;
  const now = params.now ?? Date.now;
  // Google requires jti = base64url(SHA-256(code)) on the authorization_code exchange;
  // a random jti is rejected and consumes the single-use code.
  const jti = base64url(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(params.code)));
  const dpop = await createGoogleAiPlanDpopProof(params.dpopKey, { jti }, tokenUrl, now);
  const { status, body } = await postGoogleToken({
    tokenUrl,
    client: params.client,
    form: {
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    },
    dpop,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (status !== 200 || !body.access_token || !body.refresh_token) {
    throw new Error(describeGoogleTokenError('Google sign-in failed', status, body));
  }
  if (!(body.scope ?? '').split(/\s+/).includes(GOOGLE_AI_PLAN_QUOTA_SCOPE)) {
    throw new Error(
      'Google did not grant access to the Google AI Ultra plan quota scope. Try signing in again.',
    );
  }
  const idInfo = validateGoogleAiPlanIdToken(
    body.id_token,
    params.expectedNonce,
    params.client.clientId,
    now(),
  );
  // Google uses a separate DPoP nonce namespace for refresh requests, so any
  // DPoP-Nonce returned by the code exchange is intentionally not persisted.
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
    scope: body.scope,
    identity: idInfo.email ?? idInfo.name,
    dpopKey: params.dpopKey,
  };
}

export async function refreshGoogleAiPlanToken(params: {
  tokenUrl?: string;
  client: GoogleAiPlanClient;
  refreshToken: string;
  dpopKey: GoogleAiPlanDpopKey;
  dpopNonce?: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  now?: () => number;
}): Promise<GoogleAiPlanRefreshResult> {
  const tokenUrl = params.tokenUrl ?? GOOGLE_AI_PLAN_TOKEN_URL;
  const now = params.now ?? Date.now;
  const proof: { nonce?: string; iat?: number } = {
    ...(params.dpopNonce ? { nonce: params.dpopNonce } : {}),
  };

  const send = async () => {
    const dpop = await createGoogleAiPlanDpopProof(
      params.dpopKey,
      { jti: randomBytes(24).toString('base64url'), ...proof },
      tokenUrl,
      now,
    );
    return postGoogleToken({
      tokenUrl,
      client: params.client,
      form: {
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
      },
      dpop,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
    });
  };

  let result = await send();
  // Two recoverable DPoP rejections may happen in either order:
  // 1) `use_dpop_nonce` supplies a fresh `DPoP-Nonce` header (always on first refresh).
  // 2) `invalid_dpop_proof` when local clock is >10s ahead of Google; retry using `Date`.
  for (let retry = 0; retry < 2; retry += 1) {
    if (result.body.error === 'use_dpop_nonce' && result.nonce && proof.nonce !== result.nonce) {
      proof.nonce = result.nonce;
    } else if (
      result.body.error === 'invalid_dpop_proof' &&
      proof.iat === undefined &&
      result.serverTime !== undefined
    ) {
      proof.iat = result.serverTime;
    } else {
      break;
    }
    result = await send();
  }

  const { status, body, nonce } = result;
  if (status !== 200 || !body.access_token) {
    const terminal = body.error === 'invalid_grant' || body.error === 'unauthorized_client';
    return {
      ok: false,
      terminal,
      status,
      error: terminal
        ? 'Your Google AI Ultra sign-in expired or was revoked. Sign in again in Settings → Model Providers.'
        : describeGoogleTokenError('Google token refresh failed', status, body),
    };
  }

  const dpopNonce = nonce ?? proof.nonce;
  return {
    ok: true,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
    scope: body.scope,
    ...(dpopNonce ? { dpopNonce } : {}),
  };
}
