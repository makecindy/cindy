import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDeviceAuthorizationUrl,
  parsePluginDeviceOffer,
  parsePluginOauthRequest,
} from '@cindy/device-link';
import { OauthTransactions } from '../transactions.js';
import { OauthBox } from '../box.js';
import { openDeviceAuthorizationCard } from '../deviceCard.js';
import { assistPluginOauth } from '../controller.js';
import { copyPrivateDeviceCode } from '../deviceCodeClipboard.js';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';

const url = 'https://provider.example/device?code=synthetic-private-code';
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
});
function setup(userCode?: string) {
  let current = true;
  const events: unknown[] = [];
  const bridge = new GhostSetupInteractionBridge({
    broadcast: (...args) => {
      events.push(args);
    },
  });
  const controller = new AbortController();
  const cancel = vi.fn(() => controller.abort());
  const card = openDeviceAuthorizationCard(
    {
      ghost: { id: 'plugin-a', name: 'Plugin A' },
      sessionId: 'session-a',
      url: userCode ? 'https://github.com/login/device' : url,
      ...(userCode ? { userCode } : {}),
      signal: controller.signal,
      cancel,
      assertCurrent: () => {
        if (!current) throw new Error('stale');
      },
    },
    {
      bridge,
      openExternal: async () => {
        throw new Error('cloud browser forbidden');
      },
      copy: { title: 'Authorize Plugin Login', description: 'Authorize at {{host}}' },
    },
  );
  const snapshot = bridge.pendingSnapshots()[0].request;
  const action = {
    requestId: snapshot.requestId,
    actionId: snapshot.steps[0].action!.id,
    expectedRevision: 0,
  };
  const host = new OauthTransactions({
    owner: () => (current ? 'member-a' : 'member-b'),
    available: () => true,
    bind: async (a) =>
      a.requestId === action.requestId && a.expectedRevision === 0
        ? { ghostId: 'plugin-a', current: () => bridge.pendingSnapshots().length === 1 }
        : null,
    run: (a) => bridge.resolve(a.requestId, { kind: 'plugin_setup', action: 'run_action', ...a }),
  });
  cleanup.push(() => {
    card.dispose();
    host.cancelPeer();
  });
  return {
    bridge,
    events,
    controller,
    card,
    host,
    cancel,
    action,
    stale: () => {
      current = false;
    },
  };
}

describe('private device authorization', () => {
  it.each(['abcDEF123', 'AB CD EF', '123456'])(
    'copies the exact generic provider code %s without erasing newer clipboard content',
    (code) => {
      let value = '';
      const clipboard = {
        writeText: (text: string) => {
          value = text;
        },
        readText: () => value,
        clear: () => {
          value = '';
        },
      };
      const clear = copyPrivateDeviceCode(clipboard, code);
      expect(value).toBe(code);
      clear();
      expect(value).toBe('');
      copyPrivateDeviceCode(clipboard, code);
      value = 'user clipboard';
      clear();
      expect(value).toBe('user clipboard');
    },
  );
  it.each([
    'http://provider.example/login',
    'https://user:pass@provider.example/login',
    'https://127.0.0.1/login',
    'https://[::1]/login',
    'https://foo.localhost/login',
    'https://provider.example/login#secret',
    'https://provider.example/ bad',
    'file:///tmp/login',
    'https://provider.example\\@evil.example/login',
  ])('rejects unsafe URL %s', (bad) => {
    expect(() => parseDeviceAuthorizationUrl(bad)).toThrow();
  });
  it('keeps the device offer distinct from loopback and rejects extra fields', () => {
    expect(() =>
      parsePluginDeviceOffer({
        kind: 'device',
        authorizeUrl: url,
        state: 'a'.repeat(43),
        callbackUrl: 'http://127.0.0.1:4/',
      }),
    ).toThrow();
  });
  it('opens on the controller and waits for the cloud operation, exposing no private URL on the wire/card', async () => {
    const h = setup();
    const wire: unknown[] = [];
    let opened = false;
    let finished = false;
    const assisting = assistPluginOauth(
      {
        invoke: async (req) => {
          const res = await h.host.request('desktop-a', req);
          wire.push(req, res);
          return res;
        },
        assertCurrent: () => {},
        openExternal: async (value) => {
          expect(value).toBe(url);
          opened = true;
        },
        pause: () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
      h.action,
    ).then((value) => {
      finished = true;
      return value;
    });
    await h.card.opened;
    expect(opened).toBe(true);
    expect(finished).toBe(false);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(JSON.stringify([wire, h.events])).not.toContain('synthetic-private-code');
    h.card.finish(true); // The bound Node RPC has now verified its credential use.
    await expect(assisting).resolves.toEqual({ accepted: true });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });
  it.each(['peer', 'card', 'call', 'owner'] as const)(
    'cancels after browser open on %s and rejects late success',
    async (cause) => {
      const h = setup();
      const assisting = assistPluginOauth(
        {
          invoke: (req) => h.host.request('desktop-a', req),
          assertCurrent: () => {},
          openExternal: async () => {},
          pause: () => new Promise((r) => setTimeout(r, 1)),
        },
        h.action,
      );
      const rejection = expect(assisting).rejects.toThrow();
      await h.card.opened;
      if (cause === 'peer') h.host.cancelPeer('desktop-a');
      if (cause === 'card') h.bridge.cleanupForSession('session-a', 'session_closed');
      if (cause === 'call') h.controller.abort();
      if (cause === 'owner') {
        h.stale();
        await h.host.request('desktop-a', { op: 'capabilities' });
      }
      await rejection;
      expect(h.cancel).toHaveBeenCalled();
      h.card.finish(true);
      expect(JSON.stringify(h.events)).not.toContain('"phase":"satisfied"');
      expect(JSON.stringify(h.events)).not.toContain('synthetic-private-code');
    },
  );
  it('requires peer/state/mode binding and only acknowledges the identical opened retry', async () => {
    const h = setup();
    const key = new OauthBox();
    const start = (await h.host.request('desktop-a', {
      op: 'start',
      ...h.action,
      publicKey: key.publicKey,
    })) as { id: string; publicKey: string };
    const status = (await h.host.request('desktop-a', { op: 'status', id: start.id })) as {
      offer: string;
    };
    const offer = parsePluginDeviceOffer(
      key.open(start.publicKey, start.id, 'offer', status.offer),
    );
    const box = (value: unknown) => key.seal(start.publicKey, start.id, 'callback', value);
    for (const value of [
      { state: offer.state, code: 'fake-code' },
      { kind: 'device-opened', state: 'x'.repeat(43) },
    ]) {
      await expect(
        h.host.request('desktop-a', { op: 'callback', id: start.id, box: box(value) }),
      ).rejects.toThrow();
    }
    const valid = box({ kind: 'device-opened', state: offer.state });
    await expect(
      h.host.request('desktop-b', { op: 'callback', id: start.id, box: valid }),
    ).rejects.toThrow();
    await h.host.request('desktop-a', { op: 'callback', id: start.id, box: valid });
    await h.card.opened;
    await expect(
      h.host.request('desktop-a', { op: 'callback', id: start.id, box: valid }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      h.host.request('desktop-a', {
        op: 'callback',
        id: start.id,
        box: box({ kind: 'device-opened', state: offer.state }),
      }),
    ).rejects.toThrow();
    await expect(h.host.request('desktop-a', { op: 'status', id: start.id })).resolves.toEqual({
      phase: 'exchanging',
    });
    h.card.finish(true);
  });
  it('does not open a cloud browser through generic remote run_action or stale revision', async () => {
    const h = setup();
    const rejected = expect(h.card.opened).rejects.toThrow();
    h.bridge.resolve(h.action.requestId, {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: h.action.actionId,
      expectedRevision: 0,
    });
    await Promise.resolve();
    expect(h.bridge.pendingSnapshots()[0].request.revision).toBe(0);
    h.controller.abort();
    await rejected;
  });
});

describe('private GitHub user code', () => {
  it('negotiates code support without changing old start requests', () => {
    const base = {
      op: 'start',
      requestId: 'request',
      actionId: 'action',
      expectedRevision: 0,
      publicKey: 'a'.repeat(59),
    };
    expect(parsePluginOauthRequest(base)).toEqual(base);
    expect(parsePluginOauthRequest({ ...base, deviceUserCode: true })).toEqual({
      ...base,
      deviceUserCode: true,
    });
    expect(parsePluginOauthRequest({ ...base, deviceUserCode: false })).toBeNull();
    expect(parsePluginOauthRequest({ ...base, userCode: 'ABCD-EFGH' })).toBeNull();
  });
  it('copies only inside local Main and never includes the code in card/model/relay metadata', async () => {
    const h = setup('ABCD-EFGH');
    const wire: unknown[] = [];
    const clear = vi.fn();
    const copy = vi.fn(() => clear);
    const closeView = vi.fn();
    const present = vi.fn(() => closeView);
    const assisting = assistPluginOauth(
      {
        invoke: async (req) => {
          const res = await h.host.request('desktop-a', req);
          wire.push(req, res);
          return res;
        },
        assertCurrent: () => {},
        copyDeviceCode: copy,
        presentDeviceCode: present,
        openExternal: async (value) => {
          expect(copy).toHaveBeenCalledWith('ABCD-EFGH');
          expect(value).toBe('https://github.com/login/device');
        },
        pause: () => new Promise((r) => setTimeout(r, 1)),
      },
      h.action,
    );
    await h.card.opened;
    expect(JSON.stringify([wire, h.events])).not.toContain('ABCD-EFGH');
    expect(clear).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledExactlyOnceWith(
      {
        userCode: 'ABCD-EFGH',
        authorizeUrl: 'https://github.com/login/device',
        expiresAt: expect.any(Number),
      },
      clear,
    );
    h.card.finish(true);
    expect(await assisting).toEqual({ accepted: true });
    expect(clear).toHaveBeenCalledOnce();
    expect(closeView).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('rejects an old controller before opening or delivering a code', async () => {
    const h = setup('ABCD-EFGH');
    const rejected = expect(h.card.opened).rejects.toThrow();
    const openExternal = vi.fn();
    await expect(
      assistPluginOauth(
        {
          invoke: (req) => h.host.request('desktop-a', req),
          assertCurrent: () => {},
          openExternal,
          pause: () => new Promise((r) => setTimeout(r, 1)),
        },
        h.action,
      ),
    ).rejects.toThrow();
    await rejected;
    expect(openExternal).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalled();
  });
  it('clears only the device code it owns, preserving later user copies', () => {
    let value = '';
    const clipboard = {
      readText: () => value,
      writeText: (v: string) => {
        value = v;
      },
      clear: () => {
        value = '';
      },
    };
    const clear = copyPrivateDeviceCode(clipboard, 'ABCD-EFGH');
    expect(value).toBe('ABCD-EFGH');
    value = 'user content';
    clear();
    expect(value).toBe('user content');
    const clearNext = copyPrivateDeviceCode(clipboard, 'IJKL-MNOP');
    clearNext();
    expect(value).toBe('');
  });
});
