import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AuthenticatedOauthHost,
  authenticateOauthController,
  OauthHostIdentity,
} from '../authentication.js';
import { OauthBox } from '../box.js';
import {
  parsePluginOauthHelloReply,
  PLUGIN_OAUTH_TTL_MS,
  type PluginOauthAction,
  type PluginOauthPeerIdentity,
} from '@cindy/device-link';

const action: PluginOauthAction = {
  requestId: 'card-1',
  actionId: 'oauth_connect:account',
  expectedRevision: 1,
};
function fixture(ghostId = 'test-plugin', controllerDeviceId?: string, settingsPage = false) {
  let now = Date.now(),
    owner: string | null = 'membership:g1',
    current = true;
  const identity = {
    key: new OauthHostIdentity(),
    deviceId: 'cloud-device',
    realm: 'global' as const,
    membershipId: 'membership',
  };
  const request = vi.fn(async (_peer: string, raw: unknown) => {
    const r = raw as { op: string };
    if (r.op === 'start') return { id: 'inner-transaction', publicKey: new OauthBox().publicKey };
    return { phase: 'starting', marker: 'synthetic-private-result' };
  });
  const host = new AuthenticatedOauthHost({
    identity: () => identity,
    owner: () => owner,
    available: () => true,
    bind: async () => ({
      ghostId,
      controllerDeviceId,
      ...(settingsPage ? { settingsPage: true as const } : {}),
      current: () => current,
    }),
    request,
    now: () => now,
  });
  const target: PluginOauthPeerIdentity = {
    ...identity.key.descriptor,
    deviceId: identity.deviceId,
    realm: 'global' as const,
    membershipId: identity.membershipId,
    observedAtMs: now,
    expiresAtMs: now + 60_000,
  };
  const invoke = vi.fn((raw: unknown) => host.request('desktop', raw));
  const options = {
    trustIdentity: vi.fn(async () => {}),
    target,
    peer: 'desktop',
    action,
    ghostId,
    invoke,
    assertCurrent: () => {},
    now: () => now,
  };
  return {
    host,
    target,
    options,
    request,
    invoke,
    now: (v: number) => {
      now = v;
    },
    owner: (v: string | null) => {
      owner = v;
    },
    invalidateBinding: () => {
      current = false;
    },
  };
}

describe('signed OAuth transport with explicit peer trust', () => {
  it.each(['test-plugin', '_root__test-plugin', '_ns__' + 'a'.repeat(128) + '__test-plugin'])(
    'authenticates %s before side effects and encrypts subsequent bodies',
    async (ghostId) => {
      const context = fixture(ghostId),
        call = await authenticateOauthController(context.options);
      expect(context.request).not.toHaveBeenCalled();
      await expect(call({ op: 'capabilities' })).resolves.toMatchObject({
        marker: 'synthetic-private-result',
      });
      expect(JSON.stringify(context.invoke.mock.calls)).not.toContain('capabilities');
      const frame = context.invoke.mock.calls[1][0];
      expect(JSON.stringify(await context.host.request('desktop', frame))).not.toContain(
        'synthetic-private-result',
      );
      expect(context.request).toHaveBeenCalledTimes(1); // identical retry returns the cached ciphertext, without replaying work
    },
  );
  it('rejects the former raw v1 transport', async () => {
    const f = fixture();
    await expect(
      f.host.request('desktop', { op: 'start', ...action, publicKey: new OauthBox().publicKey }),
    ).rejects.toThrow();
    await expect(f.host.request('desktop', { op: 'capabilities' })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects a settings command inside an authenticated ordinary OAuth exchange', async () => {
    const f = fixture(),
      call = await authenticateOauthController(f.options);
    await expect(
      call({ op: 'settings', id: action.requestId, command: { kind: 'close' } }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('binds an authenticated settings exchange to its page and its live lease', async () => {
    const f = fixture('test-plugin', 'desktop', true);
    const settingsAction = { requestId: 'page-1', actionId: 'settings-page', expectedRevision: 0 };
    const call = await authenticateOauthController({ ...f.options, action: settingsAction });
    await expect(call({ op: 'capabilities' })).rejects.toThrow();
    await expect(
      call({ op: 'settings', id: 'other-page', command: { kind: 'close' } }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      call({ op: 'settings', id: settingsAction.requestId, command: { kind: 'poll', after: 0 } }),
    ).resolves.toBeDefined();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.invalidateBinding();
    await expect(
      call({
        op: 'settings',
        id: settingsAction.requestId,
        command: { kind: 'fetch', path: '/kv', method: 'PUT', body: '{}' },
      }),
    ).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('rejects reuse of an authenticated nonce with a different ciphertext before dispatch', async () => {
    const f = fixture(),
      key = new OauthBox();
    const reply = parsePluginOauthHelloReply(
      await f.host.request('desktop', {
        op: 'hello',
        version: 3,
        nonce: randomBytes(32).toString('base64url'),
        publicKey: key.publicKey,
        action,
      }),
    );
    const payload = {
      nonce: randomBytes(32).toString('base64url'),
      request: { op: 'capabilities' },
    };
    const frame = () => ({
      op: 'exchange',
      id: reply.id,
      box: key.seal(
        reply.publicKey,
        `authenticated-plugin-oauth-v3:${reply.id}`,
        'callback',
        payload,
      ),
    });
    const first = frame();
    const result = await f.host.request('desktop', first);
    expect(await f.host.request('desktop', first)).toEqual(result);
    await expect(f.host.request('desktop', frame())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('replaces only the same peer and settings page without exhausting the connection quota', async () => {
    const f = fixture('test-plugin', undefined, true);
    const settingsAction = { requestId: 'page-1', actionId: 'settings-page', expectedRevision: 0 };
    const options = { ...f.options, action: settingsAction };
    const calls = [];
    for (let i = 0; i < 4; i++) {
      calls.push(
        await authenticateOauthController({
          ...options,
          action: { ...settingsAction, requestId: `page-${i + 1}` },
        }),
      );
    }
    const otherPeer = await authenticateOauthController({
      ...options,
      peer: 'desktop-b',
      invoke: (raw) => f.host.request('desktop-b', raw),
    });
    for (let i = 0; i < 6; i++) {
      const renewed = await authenticateOauthController(options);
      await expect(
        renewed({ op: 'settings', id: 'page-1', command: { kind: 'poll', after: 0 } }),
      ).resolves.toBeDefined();
    }
    await expect(
      authenticateOauthController({
        ...options,
        action: { ...settingsAction, requestId: 'page-5' },
      }),
    ).rejects.toThrow();
    await expect(
      calls[1]({ op: 'settings', id: 'page-2', command: { kind: 'poll', after: 0 } }),
    ).resolves.toBeDefined();
    await expect(
      otherPeer({ op: 'settings', id: 'page-1', command: { kind: 'poll', after: 0 } }),
    ).resolves.toBeDefined();
  });
  it.each(['none', 'owner', 'peer', 'all', 'binding', 'expiry'] as const)(
    'renews without waiting for a settings response and rechecks %s invalidation before returning it',
    async (change) => {
      const f = fixture('test-plugin', undefined, true);
      const options = {
        ...f.options,
        action: { requestId: 'page-1', actionId: 'settings-page', expectedRevision: 0 },
      };
      const call = await authenticateOauthController(options);
      let start!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.request.mockImplementationOnce(async () => {
        start();
        await completed;
        return { phase: 'starting', marker: 'original-result' };
      });
      const pending = call({ op: 'settings', id: 'page-1', command: { kind: 'poll', after: 0 } });
      await started;
      let renewed: typeof call | undefined;
      const renewal = authenticateOauthController(options).then((value) => {
        renewed = value;
      });
      try {
        await vi.waitFor(() => expect(renewed).toBeDefined());
        if (change === 'owner') f.owner('different-owner');
        else if (change === 'peer') f.host.invalidate('desktop');
        else if (change === 'all') f.host.invalidate();
        else if (change === 'binding') f.invalidateBinding();
        else if (change === 'expiry') f.now(f.target.observedAtMs + PLUGIN_OAUTH_TTL_MS);
      } finally {
        finish();
      }
      await renewal;
      if (change !== 'none') {
        await expect(pending).rejects.toThrow();
        return;
      }
      await expect(pending).resolves.toMatchObject({ marker: 'original-result' });
      await expect(
        renewed!({ op: 'settings', id: 'page-1', command: { kind: 'poll', after: 0 } }),
      ).resolves.toBeDefined();
      await expect(
        call({ op: 'settings', id: 'page-1', command: { kind: 'poll', after: 0 } }),
      ).rejects.toThrow();
    },
  );

  it('rejects a mutated authenticated envelope without invoking the transaction', async () => {
    const f = fixture(),
      call = await authenticateOauthController(f.options);
    await call({ op: 'capabilities' });
    const frame = f.invoke.mock.calls[1][0] as { op: string; id: string; box: string };
    const ciphertext = Buffer.from(frame.box, 'base64url');
    ciphertext[16] ^= 1;
    await expect(
      f.host.request('desktop', { ...frame, box: ciphertext.toString('base64url') }),
    ).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('rejects relay substitution of the client ephemeral key, before provider or browser work', async () => {
    const f = fixture(),
      attacker = new OauthBox();
    await expect(
      authenticateOauthController({
        ...f.options,
        invoke: (raw) =>
          f.host.request('desktop', { ...(raw as object), publicKey: attacker.publicKey }),
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['publicKey', 'deviceId', 'membershipId', 'realm', 'bootId'] as const)(
    'rejects a substituted trusted %s',
    async (field) => {
      const f = fixture();
      const target = {
        ...f.target,
        [field]:
          field === 'publicKey'
            ? new OauthHostIdentity().descriptor.publicKey
            : 'different-identity',
      };
      await expect(authenticateOauthController({ ...f.options, target })).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(['peer', 'ghostId'] as const)('rejects a different %s binding', async (field) => {
    const f = fixture();
    await expect(
      authenticateOauthController({ ...f.options, [field]: 'wrong-target' }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('binds the exact card action and prevents a relay from changing it', async () => {
    const f = fixture();
    await expect(
      authenticateOauthController({
        ...f.options,
        invoke: (raw) =>
          f.host.request('desktop', {
            ...(raw as object),
            action: { ...action, actionId: 'different' },
          }),
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects stale identity responses and an expired connection', async () => {
    const f = fixture();
    await expect(
      authenticateOauthController({
        ...f.options,
        // Compare against the fixture clock. Using the wall clock here can
        // advance past the fixture's frozen value between setup and assertion.
        target: { ...f.target, expiresAtMs: f.options.now() - 1 },
      }),
    ).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
    const call = await authenticateOauthController(f.options);
    f.now(Date.now() + 6 * 60_000);
    await expect(call({ op: 'capabilities' })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects other peers and changed owners even with an authentic ciphertext', async () => {
    const f = fixture(),
      call = await authenticateOauthController(f.options);
    await call({ op: 'capabilities' });
    const frame = f.invoke.mock.calls[1][0];
    await expect(f.host.request('other-desktop', frame)).rejects.toThrow();
    f.owner('membership:g2');
    await expect(f.host.request('desktop', frame)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('rejects a page configuration opened by another controller before producing an offer', async () => {
    const f = fixture('test-plugin', 'desktop-other');
    await expect(authenticateOauthController(f.options)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('prevents a connection from starting another card', async () => {
    const f = fixture(),
      call = await authenticateOauthController(f.options);
    await expect(
      call({
        op: 'start',
        ...action,
        requestId: 'different-card',
        publicKey: new OauthBox().publicKey,
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects forged plaintext success and previously valid replies to a new request', async () => {
    const f = fixture();
    let prior: unknown,
      forged = false;
    const call = await authenticateOauthController({
      ...f.options,
      invoke: async (raw) => {
        if (forged) return prior;
        const v = await f.invoke(raw);
        if ((raw as { op: string }).op === 'exchange') prior = v;
        return v;
      },
    });
    await call({ op: 'capabilities' });
    forged = true;
    await expect(call({ op: 'capabilities' })).rejects.toThrow();
    prior = { phase: 'succeeded' };
    await expect(call({ op: 'capabilities' })).rejects.toThrow();
  });
  it('limits peer invalidation to that peer', async () => {
    const f = fixture(),
      a = await authenticateOauthController(f.options);
    const b = await authenticateOauthController({
      ...f.options,
      peer: 'desktop-b',
      invoke: (raw) => f.host.request('desktop-b', raw),
    });
    f.host.invalidate('desktop');
    await expect(a({ op: 'capabilities' })).rejects.toThrow();
    await expect(b({ op: 'capabilities' })).resolves.toMatchObject({ phase: 'starting' });
  });
  it('rejects extra handshake fields including caller-supplied authority/token', async () => {
    const f = fixture();
    await expect(
      f.host.request('desktop', {
        op: 'hello',
        version: 3,
        nonce: randomBytes(32).toString('base64url'),
        publicKey: new OauthBox().publicKey,
        action,
        authority: 'https://attacker.example',
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
