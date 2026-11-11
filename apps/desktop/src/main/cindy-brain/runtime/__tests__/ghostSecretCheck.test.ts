import { describe, expect, it, vi } from 'vitest';
import { checkGhostSecret } from '../ghostSecretCheck.js';
import { handleGhostSecretsRequest } from '../ghostSecretsEndpoint.js';
import type { GhostSecretDecl } from '../../../../shared/ghost.js';

const value = 'fake-candidate-never-real';
const secret: GhostSecretDecl = {
  key: 'api_key', label: 'API Key', inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] },
  exchange: { url: 'https://api.example.com/token', bodyFormat: '{"key":"{value}"}', tokenPath: 'session' },
  check: { url: 'https://api.example.com/check', bodyFormat: '{"apiKey":"{value}"}', validPath: 'status', validValue: 'active', expiresAtPath: 'expiresAtMs', expiresAtFormat: 'unix-ms' },
};
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const run = (fetch: typeof globalThis.fetch, isCurrent = () => true, candidate = value) => checkGhostSecret({ instanceKey: 'isolated', secret, value: candidate, isCurrent, fetch });

describe('settings-only credential check', () => {
  it('exchanges a transient candidate, injects the session, and returns only validity and expiry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ session: 'fake-session-token' }))
      .mockResolvedValueOnce(ok({ status: 'active', expiresAtMs: 2000000000000, apiKey: value, session: 'fake-session-token', debug: 'private' }));
    expect(await run(fetch)).toEqual({ status: 200, body: '{"valid":true,"expiresAt":"2033-05-18T03:33:20.000Z"}' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ key: value });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fake-session-token');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ apiKey: value });
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);
  });
  it('escapes quotes, slashes and replacement characters in both request bodies', async () => {
    const candidate = 'fake-"\\-$&-key';
    const fetch = vi.fn().mockResolvedValueOnce(ok({ session: 'fake-token' })).mockResolvedValueOnce(ok({ status: 'invalid' }));
    expect(await run(fetch, undefined, candidate)).toMatchObject({ status: 200, body: '{"valid":false}' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).key).toBe(candidate);
    expect(JSON.parse(fetch.mock.calls[1][1].body).apiKey).toBe(candidate);
  });
  it.each([302, 401, 500])('does not follow or expose an exchange failure (%s)', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(value, { status, headers: { Location: 'https://evil.invalid' } }));
    expect(await run(fetch)).toEqual({ status: 502, body: '{"error":"SECRET_CHECK_FAILED"}' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, { status: { token: value } }, { status: 'active', expiresAtMs: value }])('rejects malformed projections without returning upstream data', async (data) => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ session: 'fake-token' })).mockResolvedValueOnce(ok(data));
    expect((await run(fetch)).status).toBe(502);
  });
  it('bounds upstream response bytes', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('x'.repeat(65537)));
    expect((await run(fetch)).status).toBe(502);
  });
  it('does not issue the second request after identity changes', async () => {
    let current = true;
    const fetch = vi.fn(async () => { current = false; return ok({ session: 'fake-token' }); });
    expect((await run(fetch, () => current)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('discards late result after identity changes', async () => {
    let current = true;
    const fetch = vi.fn().mockResolvedValueOnce(ok({ session: 'fake-token' })).mockImplementationOnce(async () => {
      current = false; return ok({ status: 'active' });
    });
    expect((await run(fetch, () => current)).status).toBe(403);
  });
  it('limits concurrent checks and releases the slot after completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await gate; return ok({ session: 'fake-token', status: 'active' }); });
    const first = run(fetch), second = run(fetch);
    expect((await run(fetch)).status).toBe(429);
    release();
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
    expect((await run(fetch)).status).toBe(200);
  });
  it('times out without exposing the fetch error', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error(value)), { once: true });
      }));
      const result = run(fetch);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toEqual({ status: 504, body: '{"error":"SECRET_CHECK_FAILED"}' });
    } finally { vi.useRealTimers(); }
  });
  it('does not dispatch without a declared check', async () => {
    const fetch = vi.fn();
    expect(await checkGhostSecret({ instanceKey: 'test', secret: { ...secret, check: undefined }, value, isCurrent: () => true, fetch })).toEqual({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('credential check protocol', () => {
  const vault = { saved: () => true, tail: () => 'fake', store: vi.fn(), remove: vi.fn() };
  const checkSecret = vi.fn(async () => ({ status: 200, body: '{"valid":true}' }));
  const args = { ghostId: 'test', userSecretKeys: ['api_key'], checkSecretKeys: ['api_key'], checkSecret, vault, readBodyText: async () => JSON.stringify({ value }) };
  it('advertises only declared supported checks', async () => {
    expect(JSON.parse((await handleGhostSecretsRequest({ ...args, method: 'GET', pathname: '/secrets' })).body!)[0].checkSupported).toBe(true);
    expect(JSON.parse((await handleGhostSecretsRequest({ ...args, checkSecretKeys: [], method: 'GET', pathname: '/secrets' })).body!)[0]).not.toHaveProperty('checkSupported');
  });
  it('checks without storing or deleting the candidate', async () => {
    expect((await handleGhostSecretsRequest({ ...args, method: 'POST', pathname: '/secrets/api_key/check' })).status).toBe(200);
    expect(checkSecret).toHaveBeenCalledWith('api_key', value);
    expect(vault.store).not.toHaveBeenCalled(); expect(vault.remove).not.toHaveBeenCalled();
  });
  // Exercise the HTTP entry and real projection: short credentials can coincide with
  // locally generated JSON without reflecting any upstream credential field.
  it.each([['true', 'fake-token'], ['fake-key', '2033']])('accepts a valid projection with candidate %s and token %s', async (candidate, token) => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ session: token }))
      .mockResolvedValueOnce(ok({ status: 'active', expiresAtMs: 2000000000000, private: candidate }));
    const store = vi.fn(), remove = vi.fn();
    const result = await handleGhostSecretsRequest({ ...args, method: 'POST', pathname: '/secrets/api_key/check',
      vault: { ...vault, store, remove }, readBodyText: async () => JSON.stringify({ value: candidate }),
      checkSecret: async (_key, input) => run(fetch, undefined, input) });
    expect(result).toMatchObject({ status: 200, body: '{"valid":true,"expiresAt":"2033-05-18T03:33:20.000Z"}' });
    expect(store).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('keeps unsupported checks separate from the existing save endpoint', async () => {
    expect((await handleGhostSecretsRequest({ ...args, checkSecretKeys: [], method: 'POST', pathname: '/secrets/api_key/check' })).status).toBe(404);
    vault.store.mockReturnValueOnce(true);
    expect((await handleGhostSecretsRequest({ ...args, checkSecretKeys: [], method: 'PUT', pathname: '/secrets/api_key' })).status).toBe(204);
  });
  it('rejects identity change while reading the candidate', async () => {
    const check = vi.fn(); let current = true;
    expect((await handleGhostSecretsRequest({ ...args, checkSecret: check, method: 'POST', pathname: '/secrets/api_key/check',
      isCurrent: () => current, readBodyText: async () => { current = false; return JSON.stringify({ value }); } })).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
  });
});
