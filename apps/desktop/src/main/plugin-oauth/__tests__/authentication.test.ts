import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AuthenticatedOauthHost,
  authenticateOauthController,
  OauthHostIdentity,
} from '../authentication.js';
import { OauthBox } from '../box.js';
import { parsePluginOauthHelloReply, type PluginOauthAction, type PluginOauthPeerIdentity } from '@cindy/device-link';

const action: PluginOauthAction = {
  requestId: 'card-1',
  actionId: 'oauth_connect:account',
  expectedRevision: 1,
};
function fixture() {
  let now = Date.now(),
    owner: string | null = 'membership:g1';
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
    bind: async () => ({ ghostId: 'test-plugin', current: () => true }),
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
    ghostId: 'test-plugin',
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
  };
}

describe('signed OAuth transport with explicit peer trust', () => {
  it('authenticates before any side effect and encrypts all subsequent request/reply bodies', async () => {
    const f = fixture(),
      call = await authenticateOauthController(f.options);
    expect(f.request).not.toHaveBeenCalled();
    await expect(call({ op: 'capabilities' })).resolves.toMatchObject({
      marker: 'synthetic-private-result',
    });
    expect(JSON.stringify(f.invoke.mock.calls)).not.toContain('capabilities');
    const frame = f.invoke.mock.calls[1][0];
    expect(JSON.stringify(await f.host.request('desktop', frame))).not.toContain(
      'synthetic-private-result',
    );
    expect(f.request).toHaveBeenCalledTimes(1); // identical retry returns the cached ciphertext, without replaying work
  });
  it('rejects the former raw v1 transport', async () => {
    const f = fixture();
    await expect(
      f.host.request('desktop', { op: 'start', ...action, publicKey: new OauthBox().publicKey }),
    ).rejects.toThrow();
    await expect(f.host.request('desktop', { op: 'capabilities' })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects reuse of an authenticated nonce with a different ciphertext before dispatch', async () => {
    const f = fixture(), key = new OauthBox();
    const reply = parsePluginOauthHelloReply(await f.host.request('desktop', {
      op: 'hello', version: 3, nonce: randomBytes(32).toString('base64url'),
      publicKey: key.publicKey, action,
    }));
    const payload = { nonce: randomBytes(32).toString('base64url'), request: { op: 'capabilities' } };
    const frame = () => ({
      op: 'exchange', id: reply.id,
      box: key.seal(reply.publicKey, `authenticated-plugin-oauth-v3:${reply.id}`, 'callback', payload),
    });
    const first = frame();
    const result = await f.host.request('desktop', first);
    expect(await f.host.request('desktop', first)).toEqual(result);
    await expect(f.host.request('desktop', frame())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a mutated authenticated envelope without invoking the transaction', async () => {
    const f = fixture(), call = await authenticateOauthController(f.options);
    await call({ op: 'capabilities' });
    const frame = f.invoke.mock.calls[1][0] as { op: string; id: string; box: string };
    const ciphertext = Buffer.from(frame.box, 'base64url');
    ciphertext[16] ^= 1;
    await expect(f.host.request('desktop', { ...frame, box: ciphertext.toString('base64url') })).rejects.toThrow();
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
        target: { ...f.target, expiresAtMs: Date.now() - 1 },
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
