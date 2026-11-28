/**
 * Protects the Google AI Ultra OAuth contract (PKCE + OIDC nonce + RFC 9449 DPoP)
 * through the real `createGenericOAuthService` and `google-ai-plan-oauth` entrypoints:
 * client credential isolation, `/oauth2callback` exchange, scope & ID-token checks,
 * and DPoP refresh retries (`use_dpop_nonce` + clock-skew `Date` recovery).
 * Tier: unit.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerOAuthContract, providerPresetOAuth } from '@cindy/model-providers';
import { createGenericOAuthService, type GenericOAuthStorage } from '../generic-oauth.js';
import {
  GOOGLE_AI_PLAN_CLIENT_ID_ENV,
  GOOGLE_AI_PLAN_CLIENT_SECRET_ENV,
  GOOGLE_AI_PLAN_QUOTA_SCOPE,
  resolveGoogleAiPlanOAuthClient,
} from '../google-ai-plan-oauth.js';

function makeMemoryStorage(): GenericOAuthStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    read: (id) => raw.get(id) ?? null,
    readStrict: (id) => raw.get(id) ?? null,
    write: (id, value) => {
      raw.set(id, value);
      return true;
    },
    remove: (id) => {
      raw.delete(id);
      return true;
    },
  };
}

function makeFakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  sigBytes: Buffer;
} {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>,
    sigBytes: Buffer.from(s!, 'base64url'),
  };
}

describe('Google AI Ultra DPoP OAuth', () => {
  const origClientId = process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV];
  const origClientSecret = process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV];
  const testClientId = '1234567890-cindytestclient.apps.googleusercontent.com';
  const testClientSecret = 'GOCSPX-cindy-test-desktop-secret';

  beforeEach(() => {
    delete process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV];
    delete process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV];
  });

  afterEach(() => {
    if (origClientId === undefined) delete process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV];
    else process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV] = origClientId;
    if (origClientSecret === undefined) delete process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV];
    else process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV] = origClientSecret;
  });

  it('recognizes the google-ai-plan preset contract and refuses unconfigured or foreign clients', () => {
    const oauth = providerPresetOAuth('google-ai-plan');
    expect(oauth).toBeDefined();
    expect(providerOAuthContract(oauth!)).toBe('google-ai-plan');

    expect(() => resolveGoogleAiPlanOAuthClient({})).toThrow(/not configured/i);
    expect(() =>
      resolveGoogleAiPlanOAuthClient({
        [GOOGLE_AI_PLAN_CLIENT_ID_ENV]:
          '1023131902207-qip7ip8p3hl0hi4cptjkv2dkigkt03om.apps.googleusercontent.com',
        [GOOGLE_AI_PLAN_CLIENT_SECRET_ENV]: 'GOCSPX-fake',
      }),
    ).toThrow(/dedicated Cindy Desktop app OAuth client/i);
    expect(() =>
      resolveGoogleAiPlanOAuthClient({
        [GOOGLE_AI_PLAN_CLIENT_ID_ENV]:
          '948713214926-onmd8lp4prlfl78qppbfjpl568mc504r.apps.googleusercontent.com',
        [GOOGLE_AI_PLAN_CLIENT_SECRET_ENV]: 'GOCSPX-fake',
      }),
    ).toThrow(/dedicated Cindy Desktop app OAuth client/i);
  });

  it('completes loopback /oauth2callback PKCE + nonce + DPoP login and persists bound credentials', async () => {
    process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV] = testClientId;
    process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV] = testClientSecret;

    const oauth = providerPresetOAuth('google-ai-plan')!;
    const storage = makeMemoryStorage();
    let capturedAuthUrl: URL | null = null;
    let capturedTokenReq: { headers: Headers; body: URLSearchParams } | null = null;
    const nowMs = 1_800_000_000_000;

    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = new URLSearchParams(String(init?.body ?? ''));
      capturedTokenReq = { headers, body };
      const expectedNonce = capturedAuthUrl!.searchParams.get('nonce')!;
      return new Response(
        JSON.stringify({
          access_token: 'ya29.test-access-token',
          refresh_token: '1//test-refresh-token',
          expires_in: 3600,
          scope: `openid email profile ${GOOGLE_AI_PLAN_QUOTA_SCOPE}`,
          id_token: makeFakeIdToken({
            iss: 'https://accounts.google.com',
            aud: testClientId,
            nonce: expectedNonce,
            exp: Math.floor(nowMs / 1000) + 3600,
            email: 'tester@example.com',
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'dpop-nonce': 'exchange-nonce-ignored' } },
      );
    });

    let callbackResponsePromise: Promise<Response> | null = null;
    const service = createGenericOAuthService({ fetchImpl: fetchMock });
    service.configureGenericOAuth({
      storage,
      now: () => nowMs,
      openExternal: async (url) => {
        capturedAuthUrl = new URL(url);
        const redirectUri = new URL(capturedAuthUrl.searchParams.get('redirect_uri')!);
        expect(redirectUri.pathname).toBe('/oauth2callback');
        expect(capturedAuthUrl.searchParams.get('client_id')).toBe(testClientId);
        expect(capturedAuthUrl.searchParams.get('access_type')).toBe('offline');
        expect(capturedAuthUrl.searchParams.get('prompt')).toBe('consent');
        expect(capturedAuthUrl.searchParams.get('nonce')).toBeTruthy();
        redirectUri.searchParams.set('code', 'auth-code-42');
        redirectUri.searchParams.set('state', capturedAuthUrl.searchParams.get('state')!);
        callbackResponsePromise = fetch(redirectUri.toString());
      },
    });

    const result = await service.runGenericOAuthLogin({ id: 'google-ai-plan-1', name: 'Google AI Ultra' }, oauth);
    const callbackRes = await callbackResponsePromise!;
    expect(callbackRes.status).toBe(200);
    await callbackRes.text();
    expect(result).toEqual({ ok: true });
    expect(capturedTokenReq).not.toBeNull();
    expect(capturedTokenReq!.body.get('client_id')).toBe(testClientId);
    expect(capturedTokenReq!.body.get('client_secret')).toBe(testClientSecret);
    expect(capturedTokenReq!.body.get('grant_type')).toBe('authorization_code');

    const dpop = decodeJwt(capturedTokenReq!.headers.get('dpop')!);
    expect(dpop.header.typ).toBe('dpop+jwt');
    expect(dpop.header.alg).toBe('ES256');
    expect(Object.keys(dpop.header.jwk as Record<string, unknown>).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(dpop.sigBytes.byteLength).toBe(64);
    expect(dpop.payload.htm).toBe('POST');
    expect(dpop.payload.htu).toBe('https://oauth2.googleapis.com/token');
    expect(dpop.payload.jti).toBe(createHash('sha256').update('auth-code-42').digest().toString('base64url'));

    const persisted = JSON.parse(storage.raw.get('google-ai-plan-1')!) as Record<string, unknown>;
    expect(persisted.access_token).toBe('ya29.test-access-token');
    expect(persisted.refresh_token).toBe('1//test-refresh-token');
    expect(persisted.identity).toBe('tester@example.com');
    expect(persisted.dpopKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    // Code-exchange DPoP-Nonce is not reused for refreshes.
    expect(persisted.dpopNonce).toBeUndefined();
  });

  it('rejects sign-in when Google omits the peruserquota scope or returns wrong OIDC nonce', async () => {
    process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV] = testClientId;
    process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV] = testClientSecret;
    const oauth = providerPresetOAuth('google-ai-plan')!;

    for (const scenario of ['missing-scope', 'bad-nonce'] as const) {
      const storage = makeMemoryStorage();
      let capturedAuthUrl: URL | null = null;
      const nowMs = 1_800_000_000_000;
      const service = createGenericOAuthService({
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response(
            JSON.stringify({
              access_token: 'ya29.bad',
              refresh_token: '1//bad',
              expires_in: 3600,
              scope: scenario === 'missing-scope' ? 'openid email' : `openid ${GOOGLE_AI_PLAN_QUOTA_SCOPE}`,
              id_token: makeFakeIdToken({
                iss: 'https://accounts.google.com',
                aud: testClientId,
                nonce: scenario === 'bad-nonce' ? 'wrong-nonce' : capturedAuthUrl!.searchParams.get('nonce')!,
                exp: Math.floor(nowMs / 1000) + 3600,
              }),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      });
      let callbackResponsePromise: Promise<Response> | null = null;
      service.configureGenericOAuth({
        storage,
        now: () => nowMs,
        openExternal: async (url) => {
          capturedAuthUrl = new URL(url);
          const redirectUri = new URL(capturedAuthUrl.searchParams.get('redirect_uri')!);
          redirectUri.searchParams.set('code', 'code-1');
          redirectUri.searchParams.set('state', capturedAuthUrl.searchParams.get('state')!);
          callbackResponsePromise = fetch(redirectUri.toString());
        },
      });
      const res = await service.runGenericOAuthLogin({ id: `g-${scenario}`, name: 'Google AI Ultra' }, oauth);
      const callbackRes = await callbackResponsePromise!;
      await callbackRes.text();
      expect(res.ok).toBe(false);
      expect(storage.raw.size).toBe(0);
    }
  });

  it('refreshes within 5-minute margin and recovers from both use_dpop_nonce and clock-skew invalid_dpop_proof', async () => {
    process.env[GOOGLE_AI_PLAN_CLIENT_ID_ENV] = testClientId;
    process.env[GOOGLE_AI_PLAN_CLIENT_SECRET_ENV] = testClientSecret;
    const oauth = providerPresetOAuth('google-ai-plan')!;
    const storage = makeMemoryStorage();
    let currentTime = 1_800_000_000_000;
    const serverSkewTimeSec = Math.floor((currentTime + 3_400_000) / 1000) - 45;
    let capturedAuthUrl: URL | null = null;
    let refreshAttempt = 0;
    const refreshProofs: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = new URLSearchParams(String(init?.body ?? ''));
      const grantType = body.get('grant_type');
      if (grantType === 'authorization_code') {
        return new Response(
          JSON.stringify({
            access_token: 'ya29.initial',
            refresh_token: '1//bound-refresh',
            expires_in: 3600,
            scope: `openid email profile ${GOOGLE_AI_PLAN_QUOTA_SCOPE}`,
            id_token: makeFakeIdToken({
              iss: 'https://accounts.google.com',
              aud: testClientId,
              nonce: capturedAuthUrl!.searchParams.get('nonce')!,
              exp: Math.floor(currentTime / 1000) + 3600,
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      refreshAttempt += 1;
      const proof = decodeJwt(headers.get('dpop')!);
      refreshProofs.push(proof.payload);
      if (refreshAttempt === 1) {
        return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'dpop-nonce': 'nonce-fresh-1' },
        });
      }
      if (refreshAttempt === 2) {
        return new Response(JSON.stringify({ error: 'invalid_dpop_proof' }), {
          status: 400,
          headers: {
            'content-type': 'application/json',
            date: new Date(serverSkewTimeSec * 1000).toUTCString(),
          },
        });
      }
      return new Response(
        JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json', 'dpop-nonce': 'nonce-fresh-2' } },
      );
    });

    let callbackResponsePromise: Promise<Response> | null = null;
    const service = createGenericOAuthService({ fetchImpl: fetchMock });
    service.configureGenericOAuth({
      storage,
      now: () => currentTime,
      openExternal: async (url) => {
        capturedAuthUrl = new URL(url);
        const redirectUri = new URL(capturedAuthUrl.searchParams.get('redirect_uri')!);
        redirectUri.searchParams.set('code', 'code-refresh');
        redirectUri.searchParams.set('state', capturedAuthUrl.searchParams.get('state')!);
        callbackResponsePromise = fetch(redirectUri.toString());
      },
    });

    const loginRes = await service.runGenericOAuthLogin({ id: 'g-refresh', name: 'Google AI Ultra' }, oauth);
    const callbackRes = await callbackResponsePromise!;
    await callbackRes.text();
    expect(loginRes).toEqual({ ok: true });

    // Advance into the 5-minute Google early-refresh window (4m remaining).
    currentTime += 3_360_000;
    const token = await service.readGenericOAuthAccessToken('g-refresh', oauth);
    expect(token).toBe('ya29.refreshed');
    expect(refreshAttempt).toBe(3);
    expect(refreshProofs[0]!.nonce).toBeUndefined();
    expect(refreshProofs[1]!.nonce).toBe('nonce-fresh-1');
    expect(refreshProofs[2]!.nonce).toBe('nonce-fresh-1');
    expect(refreshProofs[2]!.iat).toBe(serverSkewTimeSec);

    const persisted = JSON.parse(storage.raw.get('g-refresh')!) as Record<string, unknown>;
    expect(persisted.dpopNonce).toBe('nonce-fresh-2');
    expect(persisted.dpopKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });
});
