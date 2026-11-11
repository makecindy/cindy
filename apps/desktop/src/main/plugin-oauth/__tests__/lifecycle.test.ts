import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginOauthOffer } from '@cindy/device-link';
import { GhostOauthAccountManager } from '../../cindy-brain/ghostOauthAccounts.js';
import {
  cancelActiveGhostOauthFlow,
  startGhostOauthFlow,
} from '../../cindy-brain/ghostOauthFlow.js';
import { OauthBox } from '../box.js';
import { assistPluginOauth } from '../controller.js';
import { getRemoteOauthContext } from '../context.js';
import { OauthTransactions } from '../transactions.js';
import { AuthenticatedOauthHost, OauthHostIdentity } from '../authentication.js';
import { handleAssistPluginOauth } from '../localIpc.js';

const instances: OauthTransactions[] = [];
afterEach(() => {
  for (const h of instances.splice(0)) h.cancelPeer();
  cancelActiveGhostOauthFlow();
});
const decl = {
  clientId: 'synthetic-client',
  authorizeUrl: 'https://provider.example/authorize',
  tokenUrl: 'https://provider.example/token',
  scopes: ['read'],
};
function managed(fetchImpl: typeof fetch) {
  let owner = 'member:g1';
  const vault = new Map<string, string>();
  const manager = new GhostOauthAccountManager({
    vault: {
      read: (g, k) => vault.get(`${g}/${k}`) ?? null,
      store: (g, k, v) => {
        vault.set(`${g}/${k}`, v);
        return true;
      },
      remove: (g, k) => {
        vault.delete(`${g}/${k}`);
      },
    },
    openExternal: () => {
      throw new Error('cloud browser forbidden');
    },
    fetchImpl,
  });
  const running = new Map<string, Promise<unknown>>();
  const host = new OauthTransactions({
    owner: () => owner,
    available: () => true,
    bind: async () => ({ ghostId: 'test-plugin', current: () => true }),
    run: (action) => {
      const remote = getRemoteOauthContext()!;
      const promise = manager.connectAccount('test-plugin', action.requestId, decl, { remote });
      running.set(
        action.requestId,
        promise.then(
          (r) => {
            remote.finish(r.ok);
            return r;
          },
          () => {
            remote.finish(false);
            return { ok: false };
          },
        ),
      );
      return true;
    },
  });
  instances.push(host);
  const start = async (peer: string, card: string) => {
    const key = new OauthBox();
    const tx = (await host.request(peer, {
      op: 'start',
      requestId: card,
      actionId: 'oauth_connect:account',
      expectedRevision: 1,
      publicKey: key.publicKey,
    })) as { id: string; publicKey: string };
    let offer!: PluginOauthOffer;
    await vi.waitFor(async () => {
      const status = (await host.request(peer, { op: 'status', id: tx.id })) as { offer?: string };
      expect(status.offer).toBeTruthy();
      offer = key.open(tx.publicKey, tx.id, 'offer', status.offer!) as PluginOauthOffer;
    });
    return {
      offer,
      tx,
      callback: () =>
        host.request(peer, {
          op: 'callback',
          id: tx.id,
          box: key.seal(tx.publicKey, tx.id, 'callback', {
            state: offer.state,
            code: 'synthetic-code',
          }),
        }),
    };
  };
  return {
    host,
    vault,
    running,
    start,
    switchOwner: () => {
      owner = 'other:g2';
    },
  };
}

it.each(['owner', 'card', 'peer', 'account-boundary'] as const)(
  'never commits credentials after %s changes during token exchange',
  async (cause) => {
    let respond!: (r: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const h = managed(fetchImpl);
    const tx = await h.start('desktop-a', 'card-a');
    await tx.callback();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    if (cause === 'owner') h.switchOwner();
    if (cause === 'card') h.host.cancelRequest('card-a');
    if (cause === 'peer') h.host.cancelPeer('desktop-a');
    if (cause === 'account-boundary') cancelActiveGhostOauthFlow();
    respond(
      new Response(
        JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
      ),
    );
    await expect(h.running.get('card-a')).resolves.toMatchObject({ ok: false });
    expect(h.vault.size).toBe(0);
  },
);

it('runs two real OAuth flows independently and keeps the second after the first peer disconnects', async () => {
  const h = managed(
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
        ),
    ),
  );
  await h.start('desktop-a', 'card-a');
  const b = await h.start('desktop-b', 'card-b');
  h.host.cancelPeer('desktop-a');
  await b.callback();
  await expect(h.running.get('card-a')).resolves.toMatchObject({ ok: false });
  await expect(h.running.get('card-b')).resolves.toMatchObject({ ok: true });
  await expect(h.host.request('desktop-b', { op: 'status', id: b.tx.id })).resolves.toEqual({
    phase: 'succeeded',
  });
  expect([...h.vault.keys()].every((k) => !k.includes('card-a'))).toBe(true);
});

it('closes the local listener and cancels the cloud transaction when its window is gone', async () => {
  const fetchImpl = vi.fn();
  const h = managed(fetchImpl);
  let visible = true;
  let callback = '';
  const identity = {
    key: new OauthHostIdentity(),
    deviceId: 'cloud',
    realm: 'global' as const,
    membershipId: 'member',
  };
  const authenticated = new AuthenticatedOauthHost({
    owner: () => 'member:g1',
    available: () => true,
    identity: () => identity,
    bind: async () => ({ ghostId: 'test-plugin', current: () => true }),
    request: (peer, raw) => h.host.request(peer, raw),
  });
  const promise = handleAssistPluginOauth(
    {
      owner: () => 'member:g1',
      localDeviceId: () => 'desktop',
      trustIdentity: async () => {},
      identity: async () => ({
        ...identity.key.descriptor,
        deviceId: 'cloud',
        realm: 'global' as const,
        membershipId: 'member',
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + 59_000,
      }),
      assertTarget: () => {
        if (!visible) throw new Error('window gone');
      },
      invoke: async (_device, _channel, args) => ({
        ok: true,
        result: await authenticated.request('desktop', args[0]),
      }),
      openExternal: async (raw) => {
        callback = new URL(raw).searchParams.get('redirect_uri')!;
        const response = await fetch(callback);
        expect(response.status).toBe(400);
        await response.text();
        visible = false;
      },
    },
    {
      deviceId: 'cloud',
      ghostId: 'test-plugin',
      requestId: 'card',
      actionId: 'oauth_connect:account',
      expectedRevision: 1,
    },
  );
  await expect(promise).rejects.toThrow();
  await expect(h.running.get('card')).resolves.toMatchObject({ ok: false });
  await expect(fetch(callback)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(h.vault.size).toBe(0);
});

it('preserves a registered public bounce redirect and PKCE at the existing broker exchange', async () => {
  let challenge = '';
  let result: Promise<unknown> | undefined;
  const exchange = vi.fn(
    async (_slug: string, params: { code: string; redirectUri: string; codeVerifier?: string }) => {
      expect(params.code).toBe('synthetic-code');
      expect(params.redirectUri).toBe('https://broker.example/provider/bounce');
      expect(createHash('sha256').update(params.codeVerifier!).digest('base64url')).toBe(challenge);
      return {
        ok: true as const,
        bundle: {
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-refresh',
          expiresAt: null,
          grantedScope: null,
        },
      };
    },
  );
  const host = new OauthTransactions({
    owner: () => 'member:g1',
    available: () => true,
    bind: async () => ({ ghostId: 'p', current: () => true }),
    run: () => {
      const remote = getRemoteOauthContext()!;
      result = startGhostOauthFlow({
        remote,
        config: {
          ...decl,
          tokenBroker: 'provider',
          publicRedirectUri: 'https://broker.example/provider/bounce',
          callbackPath: '/provider/callback',
        },
        openExternal: () => {
          throw new Error('forbidden');
        },
        fetchImpl: vi.fn(),
        broker: { exchange, refresh: vi.fn() },
      }).then((r) => {
        remote.finish(r.ok);
        return r;
      });
      return true;
    },
  });
  instances.push(host);
  const key = new OauthBox();
  const tx = (await host.request('desktop', {
    op: 'start',
    requestId: 'card',
    actionId: 'oauth_connect:x',
    expectedRevision: 1,
    publicKey: key.publicKey,
  })) as { id: string; publicKey: string };
  let offer!: PluginOauthOffer;
  await vi.waitFor(async () => {
    const status = (await host.request('desktop', { op: 'status', id: tx.id })) as {
      offer?: string;
    };
    expect(status.offer).toBeTruthy();
    offer = key.open(tx.publicKey, tx.id, 'offer', status.offer!) as PluginOauthOffer;
  });
  const url = new URL(offer.authorizeUrl);
  expect(url.searchParams.get('redirect_uri')).toBe('https://broker.example/provider/bounce');
  expect(new URL(offer.callbackUrl).pathname).toBe('/provider/callback');
  challenge = url.searchParams.get('code_challenge')!;
  await host.request('desktop', {
    op: 'callback',
    id: tx.id,
    box: key.seal(tx.publicKey, tx.id, 'callback', { state: offer.state, code: 'synthetic-code' }),
  });
  await expect(result).resolves.toMatchObject({ ok: true });
  expect(exchange).toHaveBeenCalledOnce();
});

it('does not echo a provider exception into remote logs or structured errors', async () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const remote = {
    scope: 'test',
    assertCurrent: () => {},
    finish: vi.fn(),
    authorize: async (offer: PluginOauthOffer) => ({ state: offer.state, code: 'synthetic-code' }),
  };
  const result = await startGhostOauthFlow({
    config: decl,
    remote,
    openExternal: vi.fn(),
    logger: log,
    fetchImpl: async () => {
      throw new Error('synthetic-code synthetic-refresh');
    },
  });
  expect(result).toEqual({ ok: false, error: 'NETWORK' });
  expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, result])).not.toContain(
    'synthetic-code',
  );
  expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, result])).not.toContain(
    'synthetic-refresh',
  );
});

it('fails closed before browser opening on an old Host and settles rejected card dispatch immediately', async () => {
  const openExternal = vi.fn();
  const invoke = vi.fn(async () => ({ version: 0 }));
  await expect(
    assistPluginOauth(
      { invoke, openExternal, assertCurrent: () => {} },
      {
        requestId: 'card',
        actionId: 'oauth_connect:x',
        expectedRevision: 1,
      },
    ),
  ).rejects.toThrow();
  expect(invoke).toHaveBeenCalledOnce();
  expect(openExternal).not.toHaveBeenCalled();
  let fails = true;
  const h = new OauthTransactions({
    owner: () => 'member:g1',
    available: () => true,
    bind: async () => ({ ghostId: 'p', current: () => true }),
    run: () => {
      if (fails) throw new Error('synthetic private detail');
      return true;
    },
  });
  instances.push(h);
  const input = {
    op: 'start',
    requestId: 'card',
    actionId: 'oauth_connect:x',
    expectedRevision: 1,
    publicKey: new OauthBox().publicKey,
  };
  await expect(h.request('desktop', input)).rejects.toThrow('OAUTH_BRIDGE_UNAVAILABLE');
  fails = false;
  await expect(h.request('desktop', input)).resolves.toHaveProperty('id');
});
