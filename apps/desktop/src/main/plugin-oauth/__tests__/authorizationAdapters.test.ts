import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginAuthorizationRequest } from '@cindy/device-link';
import { openPluginAuthorizationCard } from '../deviceCard.js';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { OauthTransactions } from '../transactions.js';
import { assistPluginOauth } from '../controller.js';
import { openAuthorizationOffer } from '../authorizationAdapters.js';
import {
  authenticateOauthController,
  AuthenticatedOauthHost,
  OauthHostIdentity,
} from '../authentication.js';

import { ephemeralCallbackPorts } from './ephemeralCallbackPorts.js';

let sockets: ReturnType<typeof ephemeralCallbackPorts>;
beforeEach(() => {
  sockets = ephemeralCallbackPorts();
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  for (const server of sockets.servers.values()) {
    server.close();
    server.closeAllConnections();
  }
  vi.restoreAllMocks();
});
async function loopback(port = 12345) {
  const callbackUrl = 'http://127.0.0.1:' + port + '/cli/callback';
  const state = 'cli_state_0123456789';
  const url = new URL('https://provider.example/authorize');
  url.search = new URLSearchParams({
    client_id: 'fixture',
    response_type: 'code',
    state,
    redirect_uri: callbackUrl,
    code_challenge: 'p'.repeat(43),
    code_challenge_method: 'S256',
  }).toString();
  return { kind: 'loopback' as const, url: url.toString(), callbackUrl, state };
}
function harness(request: PluginAuthorizationRequest) {
  let current = true;
  const events: unknown[] = [],
    wire: unknown[] = [];
  const bridge = new GhostSetupInteractionBridge({ broadcast: (...args) => events.push(args) });
  const abort = new AbortController(),
    cancel = vi.fn(() => abort.abort());
  const card = openPluginAuthorizationCard(
    {
      ghost: { id: 'fixture-plugin', name: 'Fixture' },
      sessionId: 'task',
      request,
      signal: abort.signal,
      cancel,
      assertCurrent: () => {
        if (!current) throw new Error('stale');
      },
    },
    {
      bridge,
      openExternal: async () => {
        throw new Error('source browser forbidden');
      },
      copy: { title: 'Authorize', description: 'Continue on {{host}}' },
    },
  );
  const snapshot = bridge.pendingSnapshots()[0].request;
  const action = {
    requestId: snapshot.requestId,
    actionId: snapshot.steps[0].action!.id,
    expectedRevision: 0,
  };
  const owner = () => (current ? 'membership' : null);
  const bind = async () => ({
    ghostId: 'fixture-plugin',
    current: () => bridge.pendingSnapshots().length === 1,
  });
  const tx = new OauthTransactions({
    owner,
    available: () => true,
    bind,
    run: (a) => bridge.resolve(a.requestId, { kind: 'plugin_setup', action: 'run_action', ...a }),
  });
  const identity = {
    key: new OauthHostIdentity(),
    deviceId: 'cloud-device',
    realm: 'global' as const,
    membershipId: 'membership',
  };
  const authenticated = new AuthenticatedOauthHost({
    identity: () => identity,
    owner,
    available: () => true,
    bind,
    request: (peer, raw) => tx.request(peer, raw),
  });
  const target = {
    ...identity.key.descriptor,
    deviceId: 'cloud-device',
    realm: 'global' as const,
    membershipId: 'membership',
    observedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
  const invoke = async (raw: unknown) => {
    const reply = await authenticated.request('desktop', raw);
    wire.push(raw, reply);
    return reply;
  };
  const assist = async (
    openExternal: (url: string) => Promise<void>,
    extra: Partial<Parameters<typeof assistPluginOauth>[0]> = {},
  ) => {
    const call = await authenticateOauthController({
      trustIdentity: async () => {},
      target,
      peer: 'desktop',
      action,
      ghostId: 'fixture-plugin',
      invoke,
      assertCurrent() {},
    });
    return assistPluginOauth(
      {
        invoke: call,
        openExternal,
        assertCurrent() {},
        pause: () => new Promise((r) => setTimeout(r, 1)),
        ...extra,
      },
      action,
    );
  };
  cleanups.push(() => {
    card.dispose();
    tx.cancelPeer();
    authenticated.invalidate();
  });
  return {
    card,
    bridge,
    events,
    wire,
    tx,
    action,
    cancel,
    assist,
    abort,
    stale: () => {
      current = false;
    },
  };
}

describe('generic authorization through the signed Host bridge', () => {
  it.each(['browser', 'loopback'] as const)(
    'reopens the current generic %s transaction and closes its presentation',
    async (kind) => {
      const request =
        kind === 'loopback'
          ? await loopback()
          : {
              kind,
              url: 'https://provider.example/authorize?state=synthetic',
            };
      let current = true;
      const open = vi.fn(async () => {}),
        dismiss = vi.fn();
      let reopen!: () => Promise<void>;
      const handle = await openAuthorizationOffer(
        {
          kind: 'authorization',
          state: 's'.repeat(43),
          request,
        },
        {
          openExternal: open,
          deadline: Date.now() + 60_000,
          assertCurrent() {
            if (!current) throw new Error('stale');
          },
          deliver: async () => {},
          failed() {},
          presentBrowserAuthorization: (_expiresAt, callback) => {
            reopen = callback;
            return dismiss;
          },
        },
      );
      cleanups.push(() => handle.close());
      await reopen();
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenLastCalledWith(request.url);
      current = false;
      await expect(reopen()).rejects.toThrow('stale');
      expect(open).toHaveBeenCalledTimes(2);
      handle.close('completed');
      expect(dismiss).toHaveBeenCalledWith('completed');
    },
  );

  it('rejects an expired challenge before a browser or callback listener is opened', async () => {
    const openExternal = vi.fn(),
      deliver = vi.fn();
    await expect(
      openAuthorizationOffer(
        {
          kind: 'authorization',
          state: 's'.repeat(43),
          request: { kind: 'device', url: 'https://provider.example/activate', expiresAt: 1000 },
        },
        { openExternal, deliver, deadline: 5000, now: () => 1000, assertCurrent() {}, failed() {} },
      ),
    ).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not take a callback port already owned by another local process', async () => {
    sockets.listen.mockRestore();
    const server = http.createServer((_req, res) => res.end('existing-listener'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const request = await loopback((server.address() as { port: number }).port);
    cleanups.push(() => {
      server.close();
      server.closeAllConnections();
    });
    const h = harness(request);
    const open = vi.fn();
    await expect(h.assist(open)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(await (await fetch(request.callbackUrl)).text()).toBe('existing-listener');
  });

  it.each(['device', 'browser'] as const)(
    'opens %s on the controller but waits for actual source verification',
    async (kind) => {
      const request =
        kind === 'device'
          ? {
              kind,
              url: 'https://provider.example/activate',
              userCode: 'abcdef123',
              expiresAt: Date.now() + 60_000,
            }
          : { kind, url: 'https://provider.example/qr?request=synthetic-challenge' };
      const h = harness(request);
      const clear = vi.fn(),
        dismiss = vi.fn(),
        copy = vi.fn(() => clear),
        present = vi.fn(() => dismiss);
      let finished = false;
      const assisting = h
        .assist(
          async (url) => {
            expect(url).toBe(request.url);
          },
          { copyDeviceCode: copy, presentDeviceCode: present },
        )
        .then((result) => {
          finished = true;
          return result;
        });
      await expect(h.card.result).resolves.toEqual({ kind: 'opened' });
      expect(finished).toBe(false);
      if (kind === 'device') {
        expect(copy).toHaveBeenCalledWith('abcdef123');
        expect(present).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAt: request.expiresAt }),
          clear,
        );
      }
      h.card.finish(true);
      await expect(assisting).resolves.toEqual({ accepted: true });
      if (kind === 'device') {
        expect(clear).toHaveBeenCalled();
        expect(dismiss).toHaveBeenCalledWith('completed');
      }
      for (const secret of ['abcdef123', 'synthetic-challenge', request.url])
        expect(JSON.stringify([h.wire, h.events])).not.toContain(secret);
    },
  );

  it('delivers a real loopback callback privately with the CLI state, and consumes it once', async () => {
    const request = await loopback(),
      h = harness(request);
    let browserDone!: () => void;
    const browser = new Promise<void>((r) => {
      browserDone = r;
    });
    const assisting = h.assist(async () => {
      const bad = await sockets.fetch(request.callbackUrl + '?state=wrong&code=synthetic');
      expect(bad.status).toBe(400);
      const result = await sockets.fetch(
        request.callbackUrl + '?state=' + request.state + '&code=synthetic-callback',
      );
      expect(result.status).toBe(200);
      expect(await result.text()).not.toContain('synthetic-callback');
      const repeated = await sockets.fetch(
        request.callbackUrl + '?state=' + request.state + '&code=synthetic-callback',
      );
      expect(repeated.status).toBe(409);
      browserDone();
    });
    await expect(h.card.result).resolves.toEqual({
      kind: 'callback',
      state: request.state,
      code: 'synthetic-callback',
    });
    await browser;
    h.card.finish(true); // CLI exchange/store/probe has completed.
    await expect(assisting).resolves.toEqual({ accepted: true });
    for (const secret of ['synthetic-callback', request.state, request.url, request.callbackUrl])
      expect(JSON.stringify([h.wire, h.events])).not.toContain(secret);
    await expect(sockets.fetch(request.callbackUrl)).rejects.toThrow();
  });

  it('cannot turn a provider denial into a successful card even if the CLI misreports success', async () => {
    const request = await loopback(),
      h = harness(request);
    const assisting = h.assist(async () => {
      await sockets.fetch(request.callbackUrl + '?state=' + request.state + '&error=access_denied');
    });
    const rejection = expect(assisting).rejects.toThrow();
    await expect(h.card.result).resolves.toEqual({
      kind: 'callback',
      state: request.state,
      error: 'access_denied',
    });
    h.card.finish(true);
    await rejection;
    expect(JSON.stringify(h.events)).not.toContain('"phase":"satisfied"');
  });

  it.each(['call', 'card', 'peer', 'owner'] as const)(
    'rejects a late completion after %s invalidation',
    async (reason) => {
      const h = harness({ kind: 'browser', url: 'https://provider.example/confirm' });
      const assisting = h.assist(async () => {});
      const rejection = expect(assisting).rejects.toThrow();
      await h.card.result;
      if (reason === 'call') h.abort.abort();
      if (reason === 'card') h.bridge.cleanupForSession('task', 'session_closed');
      if (reason === 'peer') h.tx.cancelPeer('desktop');
      if (reason === 'owner') h.stale();
      h.card.finish(true);
      await rejection;
      expect(JSON.stringify(h.events)).not.toContain('"phase":"satisfied"');
    },
  );

  it('rejects unsupported old controllers before opening a browser', async () => {
    const h = harness({ kind: 'browser', url: 'https://provider.example/confirm' });
    const open = vi.fn();
    const assisting = assistPluginOauth(
      {
        invoke: async (request) => {
          const result = await h.tx.request('desktop', request);
          if (request.op === 'capabilities')
            return { ...(result as object), authorizationV1: undefined };
          return result;
        },
        openExternal: open,
        assertCurrent() {},
        pause: () => new Promise((r) => setTimeout(r, 1)),
      },
      h.action,
    );
    await expect(assisting).rejects.toThrow();
    await expect(h.card.result).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps local CLI listeners in control of their own callback port', async () => {
    sockets.listen.mockRestore();
    const server = http.createServer((_req, res) => res.end('CLI callback'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const request = await loopback((server.address() as { port: number }).port);
    cleanups.push(() => {
      server.close();
      server.closeAllConnections();
    });
    const bridge = new GhostSetupInteractionBridge({ broadcast() {} });
    const abort = new AbortController();
    const open = vi.fn(async () => {
      expect(await (await fetch(request.callbackUrl)).text()).toBe('CLI callback');
    });
    const card = openPluginAuthorizationCard(
      {
        request,
        ghost: { id: 'p', name: 'P' },
        sessionId: 't',
        signal: abort.signal,
        assertCurrent() {},
        cancel: () => abort.abort(),
      },
      { bridge, openExternal: open, copy: { title: 'Authorize', description: '{{host}}' } },
    );
    cleanups.push(card.dispose);
    const snapshot = bridge.pendingSnapshots()[0].request;
    bridge.resolve(
      snapshot.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: snapshot.steps[0].action!.id,
        expectedRevision: 0,
      },
      { isDestroyed: () => false } as never,
    );
    await expect(card.result).resolves.toEqual({ kind: 'opened' });
    card.finish(true);
    expect(open).toHaveBeenCalledOnce();
  });
});
