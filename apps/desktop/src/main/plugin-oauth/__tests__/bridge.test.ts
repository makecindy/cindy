import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePluginOauthRequest,
  type PluginOauthOffer,
  type PluginOauthRequest,
} from '@cindy/device-link';
import { OauthBox } from '../box.js';
import { OauthTransactions } from '../transactions.js';
import { getRemoteOauthContext, type RemoteOauthContext } from '../context.js';
import { assistPluginOauth, listenForOauthCallback, parseOauthOffer } from '../controller.js';
import { GhostOauthAccountManager } from '../../cindy-brain/ghostOauthAccounts.js';
import { cancelActiveGhostOauthFlow } from '../../cindy-brain/ghostOauthFlow.js';

const action = {
  requestId: 'request-1',
  actionId: 'oauth_connect:secret:account',
  expectedRevision: 1,
};
const state = 's'.repeat(43);
const offer: PluginOauthOffer = {
  authorizeUrl: `https://provider.example/authorize?response_type=code&state=${state}`,
  callbackUrl: 'http://127.0.0.1:12345/callback',
  state,
  corsOrigins: ['https://provider.example'],
  corsHosts: ['*.delivery.example'],
};
const hosts: OauthTransactions[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.cancelPeer();
  cancelActiveGhostOauthFlow();
});

function harness() {
  let owner = 'member:g1';
  let live = true;
  let now = 100;
  const contexts = new Map<string, RemoteOauthContext>();
  const host = new OauthTransactions({
    owner: () => owner,
    available: () => live,
    now: () => now,
    bind: async (a) => ({ ghostId: 'test-plugin', current: () => a.expectedRevision === 1 }),
    run: (a) => {
      contexts.set(a.requestId, getRemoteOauthContext()!);
      return true;
    },
  });
  hosts.push(host);
  const controller = new OauthBox();
  const start = async (
    peer = 'desktop-1',
    requestId = action.requestId,
    capabilities: Partial<
      Pick<
        Extract<PluginOauthRequest, { op: 'start' }>,
        'authorizationV1' | 'deviceUserCode' | 'secretSubmission'
      >
    > = {},
  ) =>
    (await host.request(peer, {
      op: 'start',
      ...action,
      requestId,
      publicKey: controller.publicKey,
      ...capabilities,
    })) as { id: string; publicKey: string };
  return {
    host,
    controller,
    contexts,
    start,
    owner: (v: string) => {
      owner = v;
    },
    live: (v: boolean) => {
      live = v;
    },
    now: (v: number) => {
      now = v;
    },
  };
}

describe('remote OAuth transactions', () => {
  it('encrypts offers and callbacks with transaction and direction binding', () => {
    const a = new OauthBox();
    const b = new OauthBox();
    const c = new OauthBox();
    const sealed = a.seal(b.publicKey, 'tx1', 'offer', offer);
    expect(sealed).not.toContain('provider');
    expect(sealed).not.toContain(state);
    expect(b.open(a.publicKey, 'tx1', 'offer', sealed)).toEqual(offer);
    for (const bad of [
      () => b.open(a.publicKey, 'tx2', 'offer', sealed),
      () => b.open(a.publicKey, 'tx1', 'callback', sealed),
      () => c.open(a.publicKey, 'tx1', 'offer', sealed),
      () => b.open(a.publicKey, 'tx1', 'offer', sealed.slice(1)),
    ])
      expect(bad).toThrow('OAUTH_BRIDGE_INVALID');
  });
  it('rejects plaintext callbacks, unknown fields and arbitrary transport commands', () => {
    for (const v of [
      { op: 'callback', id: 'tx', code: 'synthetic-code' },
      { op: 'status', id: 'tx', url: 'http://localhost' },
      { op: 'start', ...action, publicKey: new OauthBox().publicKey, scopes: ['extra'] },
      { op: 'fetch', url: 'http://localhost' },
    ])
      expect(parsePluginOauthRequest(v)).toBeNull();
  });
  it('requires the opening peer and matching state and consumes a callback once', async () => {
    const h = harness();
    const tx = await h.start();
    const context = h.contexts.get(action.requestId)!;
    const waiting = context.authorize(offer, new AbortController().signal);
    const status = (await h.host.request('desktop-1', { op: 'status', id: tx.id })) as {
      offer: string;
    };
    expect(h.controller.open(tx.publicKey, tx.id, 'offer', status.offer)).toEqual(offer);
    await expect(h.host.request('desktop-2', { op: 'status', id: tx.id })).rejects.toThrow();
    const box = (s: string) =>
      h.controller.seal(tx.publicKey, tx.id, 'callback', { state: s, code: 'synthetic-code' });
    await expect(
      h.host.request('desktop-1', { op: 'callback', id: tx.id, box: box('x'.repeat(43)) }),
    ).rejects.toThrow();
    const valid = box(state);
    await h.host.request('desktop-1', { op: 'callback', id: tx.id, box: valid });
    await expect(waiting).resolves.toEqual({ state, code: 'synthetic-code' });
    await expect(
      h.host.request('desktop-1', { op: 'callback', id: tx.id, box: valid }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      h.host.request('desktop-1', { op: 'callback', id: tx.id, box: box(state) }),
    ).rejects.toThrow();
    context.finish(true);
    await expect(h.host.request('desktop-1', { op: 'status', id: tx.id })).resolves.toEqual({
      phase: 'succeeded',
    });
    await expect(
      h.host.request('desktop-1', { op: 'callback', id: tx.id, box: valid }),
    ).rejects.toThrow();
  });
  it.each(['owner', 'expiry', 'cancel', 'card', 'disconnect'] as const)(
    'invalidates in-flight work on %s',
    async (cause) => {
      const h = harness();
      const tx = await h.start();
      const context = h.contexts.get(action.requestId)!;
      const pending = context.authorize(offer, new AbortController().signal);
      const rejected = expect(pending).rejects.toThrow('OAUTH_BRIDGE_UNAVAILABLE');
      if (cause === 'owner') h.owner('other:g2');
      if (cause === 'expiry') h.now(300_101);
      if (cause === 'disconnect') h.host.cancelPeer('desktop-1');
      if (cause === 'card') h.host.cancelRequest(action.requestId);
      if (cause === 'cancel') await h.host.request('desktop-1', { op: 'cancel', id: tx.id });
      expect(() => context.assertCurrent()).toThrow();
      await rejected;
    },
  );
  it('limits disconnect to its peer, including starts still awaiting card lookup', async () => {
    const h = harness();
    await h.start('desktop-1', 'card-a');
    await h.start('desktop-2', 'card-b');
    h.host.cancelPeer('desktop-1');
    expect(() => h.contexts.get('card-a')!.assertCurrent()).toThrow();
    expect(() => h.contexts.get('card-b')!.assertCurrent()).not.toThrow();
    let release!: () => void;
    const run = vi.fn(() => true);
    const slow = new OauthTransactions({
      owner: () => 'owner',
      available: () => true,
      bind: () =>
        new Promise((resolve) => {
          release = () => resolve({ ghostId: 'p', current: () => true });
        }),
      run,
    });
    hosts.push(slow);
    const pending = slow.request('desktop-1', {
      op: 'start',
      ...action,
      publicKey: h.controller.publicKey,
    });
    slow.cancelPeer('desktop-1');
    release();
    await expect(pending).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects concurrent starts of the same card', async () => {
    const h = harness();
    await h.start();
    await expect(h.start()).rejects.toThrow();
  });
});

describe('shared authorization transaction lifecycle', () => {
  const modes = ['oauth', 'legacy-device', 'device', 'browser', 'loopback', 'secret'] as const;
  const presentation = {
    ghostName: 'Fixture',
    title: 'API Key',
    description: '',
    intro: '',
    fieldLabel: 'API Key',
    fieldDescription: '',
    maxLength: 200,
  };
  function begin(mode: (typeof modes)[number], context: RemoteOauthContext, signal: AbortSignal) {
    if (mode === 'oauth') return context.authorize(offer, signal);
    if (mode === 'legacy-device')
      return context.authorizeDevice!(
        {
          kind: 'device',
          authorizeUrl: 'https://provider.example/device',
          state,
        },
        signal,
      );
    if (mode === 'secret')
      return context.submitSecret!({ kind: 'secret-entry', state, presentation });
    const callbackUrl = 'http://127.0.0.1:12345/cli/callback';
    const cliState = 'cli_state_0123456789';
    const params = new URLSearchParams({
      client_id: 'fixture',
      response_type: 'code',
      state: cliState,
      redirect_uri: callbackUrl,
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
    return context.authorizePlugin!(
      {
        kind: 'authorization',
        state,
        request:
          mode === 'loopback'
            ? {
                kind: 'loopback',
                url: `https://provider.example/authorize?${params}`,
                callbackUrl,
                state: cliState,
              }
            : { kind: mode, url: 'https://provider.example/activate' },
      },
      signal,
    );
  }

  it.each(modes)('cancels a pending %s offer and rejects a later success', async (mode) => {
    const h = harness();
    const tx = await h.start('desktop-1', action.requestId, {
      authorizationV1: true,
      secretSubmission: true,
    });
    const context = h.contexts.get(action.requestId)!;
    const signal = new AbortController().signal;
    const waiting = begin(mode, context, signal);
    const rejected = expect(waiting).rejects.toThrow('OAUTH_BRIDGE_UNAVAILABLE');
    expect(() => begin(mode, context, signal)).toThrow('OAUTH_BRIDGE_UNAVAILABLE');
    h.host.cancelRequest(action.requestId);
    await rejected;
    context.finish(true);
    await expect(h.host.request('desktop-1', { op: 'status', id: tx.id })).resolves.toEqual({
      phase: 'cancelled',
    });
  });

  it.each(modes)(
    'keeps %s bound to its reply type and source lifetime after exchange',
    async (mode) => {
      const h = harness();
      const tx = await h.start('desktop-1', action.requestId, {
        authorizationV1: true,
        secretSubmission: true,
      });
      const context = h.contexts.get(action.requestId)!;
      const source = new AbortController();
      const waiting = begin(mode, context, source.signal);
      const reply =
        mode === 'secret'
          ? { kind: 'secret-value', state, value: 'synthetic-pat' }
          : mode === 'oauth' || mode === 'loopback'
            ? { state, code: 'synthetic-code' }
            : { kind: 'device-opened', state };
      const wrong =
        mode === 'secret'
          ? { kind: 'device-opened', state }
          : { kind: 'secret-value', state, value: 'synthetic-pat' };
      const callback = (value: unknown) =>
        h.host.request('desktop-1', {
          op: 'callback',
          id: tx.id,
          box: h.controller.seal(tx.publicKey, tx.id, 'callback', value),
        });
      await expect(callback(wrong)).rejects.toThrow();
      await callback(reply);
      await waiting;
      await expect(h.host.request('desktop-1', { op: 'status', id: tx.id })).resolves.toEqual({
        phase: 'exchanging',
      });
      if (mode === 'secret') h.host.cancelRequest(action.requestId);
      else source.abort();
      context.finish(true);
      await expect(h.host.request('desktop-1', { op: 'status', id: tx.id })).resolves.toEqual({
        phase: 'cancelled',
      });
    },
  );
});

describe('real local loopback callback and cloud-owned account exchange', () => {
  it('stores only on the cloud Host; callback state/PKCE and redirect remain the original transaction', async () => {
    const vault = new Map<string, string>();
    const wire: unknown[] = [];
    let challenge = '';
    let exchangeCount = 0;
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
        throw new Error('Cloud browser must not open');
      },
      fetchImpl: vi.fn(async (_url, init) => {
        const form = new URLSearchParams(String(init?.body));
        exchangeCount++;
        expect(form.get('code')).toBe('synthetic-code');
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
          challenge,
        );
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-access',
            refresh_token: 'synthetic-refresh',
            expires_in: 3600,
          }),
        );
      }),
    });
    let accountRun: Promise<unknown> | undefined;
    const host = new OauthTransactions({
      owner: () => 'owner',
      available: () => true,
      bind: async () => ({ ghostId: 'test-plugin', current: () => true }),
      run: () => {
        const remote = getRemoteOauthContext()!;
        accountRun = manager
          .connectAccount(
            'test-plugin',
            'account',
            {
              authorizeUrl: 'https://provider.example/authorize',
              tokenUrl: 'https://provider.example/token',
              clientId: 'synthetic-client',
              scopes: ['read'],
            },
            { remote },
          )
          .then(
            (result) => {
              remote.finish(result.ok);
              return result;
            },
            (error) => {
              remote.finish(false);
              throw error;
            },
          );
        return true;
      },
    });
    hosts.push(host);
    const result = await assistPluginOauth(
      {
        invoke: async (request) => {
          wire.push(request);
          const reply = await host.request('desktop-1', request);
          wire.push(reply);
          return reply;
        },
        assertCurrent: () => {},
        pause: () => new Promise((resolve) => setTimeout(resolve, 5)),
        openExternal: async (raw) => {
          const authorize = new URL(raw);
          challenge = authorize.searchParams.get('code_challenge')!;
          const url = new URL(authorize.searchParams.get('redirect_uri')!);
          url.searchParams.set('state', authorize.searchParams.get('state')!);
          url.searchParams.set('code', 'synthetic-code');
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain('callback received');
        },
      },
      action,
    );
    expect(result).toEqual({ accepted: true });
    await accountRun;
    expect(exchangeCount).toBe(1);
    expect([...vault.values()]).toContain('synthetic-refresh');
    const serialized = JSON.stringify(wire);
    for (const value of [
      'synthetic-code',
      'synthetic-access',
      'synthetic-refresh',
      'provider.example',
      challenge,
    ])
      expect(serialized).not.toContain(value);
  });
  it('binds exact path, method, state and CORS without consuming malformed requests', async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const specific = { ...offer, callbackUrl: `http://127.0.0.1:${port}/callback` };
    const deliver = vi.fn(async () => {});
    const listener = await listenForOauthCallback(specific, deliver, () => {});
    try {
      const request = async (query: string, init?: RequestInit) => {
        const response = await fetch(specific.callbackUrl + query, init);
        await response.text();
        return response.status;
      };
      expect(await request('?state=wrong&code=synthetic-code')).toBe(400);
      expect(await request('?state=' + state + '&code=synthetic-code', { method: 'POST' })).toBe(
        405,
      );
      expect(
        await request('?state=' + state + '&code=synthetic-code', {
          headers: { Origin: 'https://evil.example' },
        }),
      ).toBe(403);
      expect(await request('?state=' + state + '&state=' + state + '&code=synthetic-code')).toBe(
        400,
      );
      expect(
        await request('', {
          method: 'OPTIONS',
          headers: { Origin: 'https://sub.delivery.example' },
        }),
      ).toBe(204);
      expect(deliver).not.toHaveBeenCalled();
      expect(await request('?state=' + state + '&code=synthetic-code')).toBe(200);
      expect(await request('?state=' + state + '&code=synthetic-code')).toBe(409);
      expect(deliver).toHaveBeenCalledOnce();
      await expect(listenForOauthCallback(specific, deliver, () => {})).rejects.toThrow();
    } finally {
      listener.close();
    }
  });
  it('never interprets a remote address, credential or command as a callback destination', () => {
    for (const callbackUrl of [
      'http://localhost:123/cb',
      'http://127.0.0.1.evil.example:123/cb',
      'https://127.0.0.1:123/cb',
      'http://127.0.0.1:123/cb?q=x',
    ])
      expect(() => parseOauthOffer({ ...offer, callbackUrl })).toThrow();
    expect(() => parseOauthOffer({ ...offer, command: 'execute' })).toThrow();
    expect(() =>
      parseOauthOffer({ ...offer, authorizeUrl: 'https://user:pass@provider.example' }),
    ).toThrow();
  });
});
