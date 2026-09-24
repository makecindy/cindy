import { testOauthSigningKey } from './fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhostManifest, GhostSetupAssessment } from '../../../shared/ghost.js';
import { createPluginConnectionPresentation } from '../../../shared/pluginOauth.js';
import { GhostSetupChangeBus } from '../../cindy-brain/ghostSetupChangeBus.js';
import { GhostSetupCoordinator } from '../../cindy-brain/ghostSetupCoordinator.js';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { GhostConnectionManager } from '../../cindy-brain/ghostConnections.js';
import { executeGhostSetupConnectionSubmission } from '../../cindy-brain/ghostSetupConnectionExecutor.js';
import { initializePluginOauthCards } from '../cards.js';
import { assistPluginOauth, type OauthControllerDeps } from '../controller.js';
import {
  handleAssistPluginOauth,
  handleSubmitPluginConnection,
  type LocalOauthDeps,
} from '../localIpc.js';
import {
  invalidatePluginOauth,
  publishedPluginOauthIdentity,
  requestPluginOauth,
} from '../runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  invalidatePluginOauth();
});
const input = { host: 'https://git.example.test/', token: 'synthetic-connection-token' };
async function harness(fault?: 'vault' | 'owner' | 'manifest' | 'stale', configured = false) {
  let owner = 'membership';
  const values = new Map<string, string>(),
    wire: unknown[] = [],
    messages: unknown[] = [];
  const store = vi.fn((ghost: string, key: string, value: string) => {
    if (fault === 'vault') return false;
    values.set(`${ghost}:${key}`, value);
    return true;
  });
  const manager = new GhostConnectionManager({
    vault: {
      store,
      read: (ghost, key) => values.get(`${ghost}:${key}`) ?? null,
      remove: (ghost, key) => {
        values.delete(`${ghost}:${key}`);
      },
      readTail: () => null,
    },
  });
  if (configured) {
    manager.upsert('demo', 'service', {
      host: 'git.example.test',
      token: 'synthetic-old-token',
      max: 2,
    });
    manager.upsert('demo', 'service', {
      host: 'other.example.test',
      token: 'synthetic-other-token',
      max: 2,
    });
    store.mockClear();
  }
  const changes = new GhostSetupChangeBus();
  const bridge = new GhostSetupInteractionBridge({ broadcast: (...args) => messages.push(args) });
  const action = { id: 'manage_connection:connection:service', kind: 'manage_connection' as const };
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    tools: [],
    network: {
      hosts: [],
      connections: [
        {
          key: 'service',
          label: 'Service',
          maxConnections: 2,
          inject: { header: 'PRIVATE-TOKEN', format: '{value}' },
        },
      ],
    },
  };
  const assess = (): GhostSetupAssessment => ({
    state: values.size ? 'ready' : 'required',
    revision: changes.currentRevision('demo'),
    groups: [
      {
        id: 'connection',
        mode: 'any_of',
        items: [
          {
            ref: 'connection:service',
            kind: 'connection',
            label: 'Service',
            state: values.size ? 'satisfied' : 'missing',
            actions: [action],
          },
        ],
      },
    ],
  });
  const coordinator = new GhostSetupCoordinator({
    bridge,
    changeBus: changes,
    assess,
    remoteConnection: true,
    validateTarget: () => ({ ok: true }),
    getGhostIdentity: () => ({ id: 'demo', name: 'Demo' }),
    executeAction: async () => ({ ok: true }),
    terminalGraceMs: 0,
  });
  const save = vi.fn((args) => {
    if (fault === 'owner') owner = 'different-owner';
    return executeGhostSetupConnectionSubmission(
      {
        manager,
        getAssessment: () =>
          fault === 'stale' ? { state: 'ready', revision: 2, groups: [] } : assess(),
        getManifest: () =>
          fault === 'manifest' ? { ...manifest, network: { hosts: [] } } : manifest,
        emitChange: () => changes.emit('demo', { source: 'connection', ref: 'service' }),
      },
      { ...args, expectedManifest: JSON.stringify(manifest) },
    );
  });
  initializePluginOauthCards({
    loadKey: testOauthSigningKey,
    bridge,
    bots: () => null,
    owner: () => owner,
    available: () => true,
    identity: () => ({
      deviceId: 'cloud-device',
      realm: 'global' as const,
      membershipId: 'membership',
    }),
    bindConnection: (args) => (value) => save({ ...args, value }),
  });
  const abort = new AbortController();
  const ready = coordinator.ensureReady({
    sessionId: 'task',
    ghostId: 'demo',
    signal: abort.signal,
    reauthorize: configured,
  });
  cleanups.push(() => abort.abort());
  await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
  const snapshot = bridge.pendingSnapshots()[0].request;
  const target = {
    deviceId: 'cloud-device',
    ghostId: 'demo',
    requestId: snapshot.requestId,
    actionId: action.id,
    expectedRevision: snapshot.revision,
  };
  const presentation = createPluginConnectionPresentation(snapshot, snapshot.steps[0]);
  const openExternal = vi.fn(async () => {
    throw new Error('No browser for a connection form');
  });
  const deps: LocalOauthDeps = {
    owner: () => owner,
    assertTarget: (device) => {
      if (device !== 'cloud-device') throw new Error('target');
    },
    localDeviceId: () => 'desktop',
    openExternal,
    trustIdentity: async () => {},
    identity: async () => ({
      ...(await publishedPluginOauthIdentity())!,
      deviceId: 'cloud-device',
      realm: 'global' as const,
      membershipId: 'membership',
      observedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    }),
    invoke: async (_device, _channel, args) => {
      const result = await requestPluginOauth('desktop', args[0]);
      wire.push({ request: args[0], result });
      return { ok: true, result };
    },
  };
  return {
    ready,
    values,
    store,
    save,
    wire,
    messages,
    openExternal,
    manager,
    target,
    presentation,
    deps,
    abort,
    bridge,
    submit: (override: Record<string, unknown> = {}) =>
      handleSubmitPluginConnection(deps, {
        ...target,
        presentation,
        value: input,
        ...override,
      }),
  };
}

describe('authenticated exact-host connection form', () => {
  it('reopens an existing connection and replaces only its token after the signed submission commits', async () => {
    const h = await harness(undefined, true);
    const before = h.manager.list('demo', 'service');
    const receipt = vi.spyOn(h.bridge, 'connectionCommitted');
    expect(h.store).not.toHaveBeenCalled();
    expect(h.bridge.pendingSnapshots()).toHaveLength(1);
    await expect(h.submit()).resolves.toEqual({ accepted: true });
    expect(receipt).toHaveReturnedWith(true);
    await expect(h.ready).resolves.toMatchObject({ ok: true });
    expect(h.manager.list('demo', 'service')).toEqual(before);
    expect(h.manager.resolveTokenByHost('demo', 'service', 'git.example.test')).toBe(input.token);
    expect(h.manager.resolveTokenByHost('demo', 'service', 'other.example.test')).toBe(
      'synthetic-other-token',
    );
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([h.wire, h.messages])).not.toContain(input.token);
    expect(JSON.stringify([h.wire, h.messages])).not.toContain('synthetic-old-token');
  });
  it('cancelled reconfiguration keeps existing credentials and refuses the stale card', async () => {
    const h = await harness(undefined, true);
    h.abort.abort();
    await expect(h.ready).resolves.toMatchObject({ ok: false, errorCode: 'SETUP_CANCELLED' });
    await expect(h.submit()).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
    expect(h.manager.resolveTokenByHost('demo', 'service', 'git.example.test')).toBe(
      'synthetic-old-token',
    );
  });
  it('rejects an old reader before creating a transaction and drops private input', async () => {
    const invoke = vi.fn(async () => ({
      version: 1,
      callback: 'desktop-loopback',
      encrypted: true,
      secretSubmission: true,
    }));
    const deps: OauthControllerDeps = {
      invoke,
      assertCurrent: vi.fn(),
      openExternal: vi.fn(),
      connectionValue: input,
    };
    await expect(
      assistPluginOauth(deps, { requestId: 'card', actionId: 'connection', expectedRevision: 1 }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deps.connectionValue).toBeUndefined();
  });
  it('writes through the existing connection manager and resumes the card without plaintext in transport/history', async () => {
    const h = await harness();
    await expect(h.submit()).resolves.toEqual({ accepted: true });
    await expect(h.ready).resolves.toMatchObject({ ok: true });
    expect(h.manager.resolveTokenByHost('demo', 'service', 'git.example.test')).toBe(input.token);
    expect(h.manager.resolveTokenByHost('demo', 'service', 'other.example.test')).toBeNull();
    expect(h.manager.resolveTokenByHost('other-plugin', 'service', 'git.example.test')).toBeNull();
    expect(h.manager.list('demo', 'service')).toHaveLength(1);
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(JSON.stringify([h.wire, h.messages])).not.toContain(input.token);
    for (const entry of h.wire as Array<{ request: { op: string }; result: unknown }>) {
      if (entry.request.op === 'exchange')
        await expect(requestPluginOauth('desktop', entry.request)).resolves.toEqual(entry.result);
    }
    expect(h.save).toHaveBeenCalledTimes(1);
  });
  it.each(['ghostName', 'title', 'description', 'intro', 'connectionKey'])(
    'rejects changed displayed %s',
    async (field) => {
      const h = await harness();
      await expect(
        h.submit({ presentation: { ...h.presentation, [field]: 'changed' } }),
      ).rejects.toThrow();
      expect(h.store).not.toHaveBeenCalled();
    },
  );
  it.each(['vault', 'owner', 'manifest', 'stale'] as const)(
    'does not report saved when %s changes',
    async (fault) => {
      const h = await harness(fault);
      await expect(h.submit()).rejects.toThrow();
      expect(h.values.size).toBe(0);
      if (fault !== 'vault') expect(h.store).not.toHaveBeenCalled();
    },
  );
  it.each([
    { deviceId: 'other-device' },
    { ghostId: 'other-plugin' },
    { expectedRevision: 99 },
    { actionId: 'manage_connection:connection:another' },
    { storageKey: 'forged' },
    { value: { host: 'https://git.example.test/malicious', token: input.token } },
  ])('rejects cross-target/invalid input %#', async (override) => {
    const h = await harness();
    await expect(h.submit(override)).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
  });
  it('does not grant input capability to ordinary assist', async () => {
    const h = await harness();
    await expect(handleAssistPluginOauth(h.deps, h.target)).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
  });
});
