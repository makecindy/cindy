import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_OAUTH_CHANNEL, type InvokeResultPayload } from '@cindy/device-link';
import {
  authenticateOauthController,
  AuthenticatedOauthHost,
  OauthHostIdentity,
} from '../authentication.js';
import { resolveOauthPeerIdentity } from '../identityResolver.js';
import { oauthSecureStorageAvailable, type OauthIdentityScope } from '../identityStore.js';
import {
  initializePluginOauthHost,
  invalidatePluginOauth,
  publishedPluginOauthIdentity,
  requestPluginOauth,
  supportsRemotePluginOauth,
} from '../runtime.js';
import { testOauthIdentityStore, testOauthSigningKey } from './fixtures.js';

const scope: OauthIdentityScope = {
  realm: 'global',
  membershipId: 'synthetic-member',
  deviceId: 'controller',
};
const remote = { ...scope, deviceId: 'remote-desktop' };
const action = { requestId: 'card', actionId: 'oauth_connect:account', expectedRevision: 1 };
const dirs: string[] = [];
afterEach(() => {
  invalidatePluginOauth();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-oauth-peer-'));
  dirs.push(dir);
  return dir;
};

async function fixture(now?: () => number) {
  const local = testOauthIdentityStore(directory()),
    target = testOauthIdentityStore(directory());
  const signingKey = await target.store.load(remote, () => {});
  let identity = { ...remote, key: new OauthHostIdentity(signingKey) };
  const operation = vi.fn(async () => ({ phase: 'starting' }));
  const host = new AuthenticatedOauthHost({
    owner: () => 'owner:1',
    available: () => true,
    identity: () => identity,
    bind: async () => ({ ghostId: 'test-plugin', current: () => true }),
    request: operation,
    now,
  });
  const invoke = vi.fn(
    async (device: string, channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
      expect(device).toBe(remote.deviceId);
      expect(channel).toBe(PLUGIN_OAUTH_CHANNEL);
      return { ok: true, result: await host.request(scope.deviceId, args[0]) };
    },
  );
  const resolve = () =>
    resolveOauthPeerIdentity({ scope: () => scope, invoke, now }, remote.deviceId, () => {});
  const connect = async (store = local.store) =>
    authenticateOauthController({
      target: await resolve(),
      peer: scope.deviceId,
      action,
      ghostId: 'test-plugin',
      assertCurrent: () => {},
      trustIdentity: (id, check) => store.trustPeer(scope, id.deviceId, id.publicKey, check),
      invoke: (raw) => host.request(scope.deviceId, raw),
    });
  return {
    local,
    target,
    resolve,
    connect,
    invoke,
    operation,
    host,
    restart: async () => {
      host.invalidate();
      identity = {
        ...remote,
        key: new OauthHostIdentity(await target.restart().load(remote, () => {})),
      };
    },
    replace: async () => {
      host.invalidate();
      identity = { ...remote, key: new OauthHostIdentity(await testOauthSigningKey()) };
    },
  };
}

describe('ordinary Desktop identity admission without CIS', () => {
  it('accepts a fresh descriptor when the clock advances between individual reads', async () => {
    let clock = Date.now();
    const f = await fixture(() => clock++);
    const identity = await f.resolve();
    expect(identity.expiresAtMs - identity.observedAtMs).toBe(60_000);
    expect(identity.deviceId).toBe(remote.deviceId);
    expect(f.operation).not.toHaveBeenCalled();
  });
  it('resolves on the authorized channel, verifies possession and persists continuity across both restarts', async () => {
    const f = await fixture(),
      first = await f.resolve();
    expect(f.invoke.mock.calls[0][2]).toEqual([{ op: 'identity', version: 3 }]);
    expect(fs.readdirSync(path.dirname(f.local.deps.filePath(scope)))).toEqual([]);
    await (
      await f.connect()
    )({ op: 'capabilities' });
    await f.restart();
    const second = await f.resolve();
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.bootId).not.toBe(first.bootId);
    await (
      await f.connect(f.local.restart())
    )({ op: 'capabilities' });
    expect(f.operation).toHaveBeenCalledTimes(2);
    await f.replace();
    await expect(f.connect(f.local.restart())).rejects.toThrow();
    expect(f.operation).toHaveBeenCalledTimes(2);
  });
  it('does not write a pin for a forged handshake or continue after a cancelled trust operation', async () => {
    const f = await fixture(),
      target = await f.resolve();
    const trustIdentity = vi.fn((id, check) =>
      f.local.store.trustPeer(scope, id.deviceId, id.publicKey, check),
    );
    const options = {
      target,
      trustIdentity,
      peer: scope.deviceId,
      action,
      ghostId: 'test-plugin',
      assertCurrent: () => {},
      invoke: (raw: unknown) => f.host.request(scope.deviceId, raw),
    };
    await expect(
      authenticateOauthController({
        ...options,
        invoke: async (raw) => ({
          ...((await options.invoke(raw)) as object),
          signature: 'A'.repeat(86),
        }),
      }),
    ).rejects.toThrow();
    expect(trustIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(f.local.deps.filePath(scope))).toBe(false);
    let current = true;
    await expect(
      authenticateOauthController({
        ...options,
        assertCurrent: () => {
          if (!current) throw Error('cancelled');
        },
        trustIdentity: async (_id, check) => {
          current = false;
          check();
        },
      }),
    ).rejects.toThrow();
    expect(f.operation).not.toHaveBeenCalled();
  });
  it.each([
    { realm: 'cn' },
    { membershipId: 'other-member' },
    { deviceId: 'other-device' },
    { observedAtMs: 0 },
    { expiresAtMs: 0 },
    { version: 2 },
    { instanceId: 'old-instance' },
  ])(
    'rejects a mismatched/stale/legacy descriptor %j without invoking authorization',
    async (override) => {
      const f = await fixture(),
        valid = await f.resolve();
      await expect(
        resolveOauthPeerIdentity(
          {
            scope: () => scope,
            invoke: async () => ({ ok: true, result: { ...valid, ...override } }),
          },
          remote.deviceId,
          () => {},
        ),
      ).rejects.toThrow();
      expect(f.operation).not.toHaveBeenCalled();
    },
  );
  it('rejects an owner change during discovery and an old peer without falling back', async () => {
    const f = await fixture();
    let current = scope;
    await expect(
      resolveOauthPeerIdentity(
        {
          scope: () => current,
          invoke: async (...args) => {
            const result = await f.invoke(...args);
            current = { ...scope, membershipId: 'other-member' };
            return result;
          },
        },
        remote.deviceId,
        () => {},
      ),
    ).rejects.toThrow();
    const invoke = vi.fn(
      async (
        _device: string,
        _channel: string,
        _args: unknown[],
      ): Promise<InvokeResultPayload> => ({
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported' },
      }),
    );
    await expect(
      resolveOauthPeerIdentity({ scope: () => scope, invoke }, remote.deviceId, () => {}),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toBe(PLUGIN_OAUTH_CHANNEL);
  });
});

describe('lazy secure identity lifecycle', () => {
  it('projects capability without accessing secure storage and rejects a cancelled async load', async () => {
    let release!: (key: Awaited<ReturnType<typeof testOauthSigningKey>>) => void;
    const load = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof testOauthSigningKey>>>((resolve) => {
          release = resolve;
        }),
    );
    initializePluginOauthHost(
      { owner: () => 'owner', available: () => true, bind: async () => null, run: () => false },
      () => remote,
      load,
    );
    expect(supportsRemotePluginOauth()).toBe(true);
    expect(load).not.toHaveBeenCalled();
    const pending = publishedPluginOauthIdentity();
    invalidatePluginOauth();
    release(await testOauthSigningKey());
    await expect(pending).rejects.toThrow();
  });
  it('checks remote permission before reading secure storage', async () => {
    const load = vi.fn(testOauthSigningKey);
    initializePluginOauthHost(
      { owner: () => 'owner', available: () => false, bind: async () => null, run: () => false },
      () => remote,
      load,
    );
    await expect(
      requestPluginOauth('controller', { op: 'identity', version: 3 }),
    ).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it.each([undefined, 'unknown', 'basic_text'])('rejects insecure Linux backend %s', (backend) => {
    expect(oauthSecureStorageAvailable({ platform: 'linux', available: true, backend })).toBe(
      false,
    );
  });
  it('requires secure storage on all platforms', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(
        oauthSecureStorageAvailable({ platform, available: false, backend: 'gnome_libsecret' }),
      ).toBe(false);
      expect(
        oauthSecureStorageAvailable({ platform, available: true, backend: 'gnome_libsecret' }),
      ).toBe(true);
    }
  });
});
