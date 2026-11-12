import { describe, expect, it, vi } from 'vitest';

import type { GhostNetworkNeeds, InstalledGhost } from '../../../shared/ghost.js';
import { GhostNetworkSlot, type NetworkSlotDeps } from '../networkSlot.js';

const URL = 'https://service-a.x.test/whoami';
const INPUT = {
  membershipId: 'membership-1',
  audience: 'org-example:plugin-a',
  allowedHosts: ['service-a.x.test'],
};
const TOKEN_INPUT = { membershipId: INPUT.membershipId, audience: INPUT.audience };

function ghost(
  hosts: string[] = ['service-a.x.test'],
  injectHosts: string[] = ['service-a.x.test'],
): InstalledGhost {
  const network: GhostNetworkNeeds = {
    hosts,
    secrets: [
      {
        key: 'cindy_identity',
        label: 'Cindy Enterprise Identity',
        source: 'oidc-token',
        inject: {
          header: 'Authorization',
          format: 'Bearer {value}',
          hosts: injectHosts,
        },
      },
    ],
  };
  return {
    manifest: {
      schemaVersion: 2,
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      tools: [{ name: 'whoami_a', description: 'Show identity' }],
      network,
    },
    dir: '/fake/plugin-a',
    enabled: true,
    approval: { state: 'approved', revision: 'rev-a' },
  };
}

function response(status = 200): Response {
  return new Response(JSON.stringify({ service: 'a', ok: status === 200 }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSlot(overrides: Partial<NetworkSlotDeps> = {}) {
  const fetchImpl = vi.fn<NetworkSlotDeps['fetchImpl']>(async () => response());
  const resolve = vi.fn(() => INPUT);
  const getToken = vi.fn(async () => 'connection.jwt.value');
  const invalidate = vi.fn();
  const deps: NetworkSlotDeps = {
    getGhost: () => ghost(),
    readSecret: () => null,
    getLoginEmail: () => null,
    fetchImpl,
    fetchPublicImpl: async () => ({ response: response(), release: async () => undefined }),
    readGhostMedia: async () => null,
    takeDirDeposit: () => null,
    writeSaveDeposit: async () => null,
    saveGhostMedia: async () => ({ url: '', hash: '', ext: '' }),
    isSupportedMediaMime: () => false,
    connectionTokens: { resolve, getToken, invalidate },
    ...overrides,
  };
  return {
    slot: new GhostNetworkSlot(deps),
    fetchImpl,
    resolve,
    getToken,
    invalidate,
  };
}

describe('networkSlot Connection identity', () => {
  it('replaces a plugin-supplied Authorization header and never returns the token', async () => {
    const h = makeSlot();
    const result = await h.slot.handleFetchRequest('plugin-a', {
      url: URL,
      headers: { Authorization: 'Bearer forged-by-plugin' },
    });

    expect(result.ok).toBe(true);
    expect(h.getToken).toHaveBeenCalledWith(TOKEN_INPUT);
    expect(h.fetchImpl.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer connection.jwt.value',
    });
    expect(JSON.stringify(result)).not.toContain('connection.jwt.value');
    expect(JSON.stringify(result)).not.toContain('forged-by-plugin');
  });

  it('fails closed when the audience resolver does not authorize the plugin', async () => {
    const h = makeSlot({
      connectionTokens: {
        resolve: () => null,
        getToken: vi.fn(async () => {
          throw new Error('must not issue');
        }),
        invalidate: vi.fn(),
      },
    });
    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(false);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('org-example');
  });

  it('fails closed before issuance when the target host is absent from the manifest', async () => {
    const h = makeSlot({
      connectionTokens: {
        resolve: () => ({ ...INPUT, allowedHosts: ['other.x.test'] }),
        getToken: vi.fn(async () => {
          throw new Error('must not issue');
        }),
        invalidate: vi.fn(),
      },
    });
    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(false);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(INPUT.audience);
  });

  it('blocks a redirect before the second request when its host is not in the manifest', async () => {
    const h = makeSlot({
      getGhost: () =>
        ghost(
          ['service-a.x.test', 'service-b.x.test'],
          ['service-a.x.test', 'service-b.x.test'],
        ),
    });
    h.fetchImpl.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://service-b.x.test/whoami' },
      }),
    );

    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(false);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.getToken).toHaveBeenCalledTimes(1);
  });

  it('invalidates, reissues, and replays exactly once after a 401', async () => {
    const h = makeSlot();
    h.fetchImpl.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));
    h.getToken.mockResolvedValueOnce('connection.jwt.1').mockResolvedValueOnce('connection.jwt.2');

    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith(TOKEN_INPUT);
    expect(h.fetchImpl.mock.calls.map((call) => call[1].headers.Authorization)).toEqual([
      'Bearer connection.jwt.1',
      'Bearer connection.jwt.2',
    ]);
  });

  it('invalidates but does not replay a non-idempotent request after a 401', async () => {
    const h = makeSlot();
    h.fetchImpl.mockResolvedValue(response(401));

    const result = await h.slot.handleFetchRequest('plugin-a', {
      url: URL,
      method: 'POST',
      body: '{"action":"create"}',
    });

    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith(TOKEN_INPUT);
  });

  it.each([301, 302, 303])(
    'does not replay an original POST after a %s redirect downgrades it to GET before a 401',
    async (redirectStatus) => {
      const h = makeSlot();
      h.fetchImpl
        .mockResolvedValueOnce(
          new Response(null, {
            status: redirectStatus,
            headers: { location: 'https://service-a.x.test/after-redirect' },
          }),
        )
        .mockResolvedValueOnce(response(401));

      const result = await h.slot.handleFetchRequest('plugin-a', {
        url: URL,
        method: 'POST',
        body: '{"action":"create"}',
      });

      expect(result).toMatchObject({ ok: true, status: 401 });
      expect(h.fetchImpl).toHaveBeenCalledTimes(2);
      expect(h.fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'GET']);
      expect(h.getToken).toHaveBeenCalledTimes(2);
      expect(h.invalidate).toHaveBeenCalledTimes(1);
      expect(h.invalidate).toHaveBeenCalledWith(TOKEN_INPUT);
    },
  );

  it('does not retry 403 and never retries a second 401', async () => {
    const forbidden = makeSlot();
    forbidden.fetchImpl.mockResolvedValue(response(403));
    const forbiddenResult = await forbidden.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(forbiddenResult).toMatchObject({ ok: true, status: 403 });
    expect(forbidden.fetchImpl).toHaveBeenCalledTimes(1);
    expect(forbidden.invalidate).not.toHaveBeenCalled();

    const unauthorized = makeSlot();
    unauthorized.fetchImpl.mockResolvedValue(response(401));
    const unauthorizedResult = await unauthorized.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(unauthorizedResult).toMatchObject({ ok: true, status: 401 });
    expect(unauthorized.fetchImpl).toHaveBeenCalledTimes(2);
    expect(unauthorized.invalidate).toHaveBeenCalledTimes(1);
  });

  it('cancels before fetch when the active Membership changes after issuance', async () => {
    const h = makeSlot();
    h.resolve
      .mockReturnValueOnce(INPUT)
      .mockReturnValueOnce({ ...INPUT, membershipId: 'membership-2' });
    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(false);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('connection.jwt.value');
  });

  it('cancels before fetch when the manifest no longer authorizes the injected hostname', async () => {
    const h = makeSlot();
    h.resolve
      .mockReturnValueOnce(INPUT)
      .mockReturnValueOnce({ ...INPUT, allowedHosts: ['other.x.test'] });
    const result = await h.slot.handleFetchRequest('plugin-a', { url: URL });
    expect(result.ok).toBe(false);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('connection.jwt.value');
  });
});
