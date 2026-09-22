import { testOauthSigningKey } from './fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GhostManifest,
  GhostSetupAllowedAction,
  GhostSetupAssessment,
} from '../../../shared/ghost.js';
import { GhostSetupChangeBus } from '../../cindy-brain/ghostSetupChangeBus.js';
import { GhostSetupCoordinator } from '../../cindy-brain/ghostSetupCoordinator.js';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { executeGhostSetupInlineSubmission } from '../../cindy-brain/ghostSetupInlineExecutor.js';
import { initializePluginOauthCards } from '../cards.js';
import { assistPluginOauth } from '../controller.js';
import {
  handleAssistPluginOauth,
  handleSubmitPluginSecret,
  type LocalOauthDeps,
} from '../localIpc.js';
import {
  invalidatePluginOauth,
  publishedPluginOauthIdentity,
  requestPluginOauth,
} from '../runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  invalidatePluginOauth();
});
const input = 'synthetic-pat-never-in-messages';
const inline: Extract<GhostSetupAllowedAction, { kind: 'inline_form' }> = {
  id: 'inline_form:bound-key',
  kind: 'inline_form',
  form: {
    fields: [{ id: 'value', type: 'secret', label: 'API Key', required: true, maxLength: 200 }],
  },
};

async function harness(options: { failStore?: boolean; holdStore?: boolean; saved?: boolean } = {}) {
  let owner: string | null = 'membership';
  let source: 'user' | 'oauth' = 'user';
  const values = new Map<string, string>(options.saved ? [['demo:api_key', 'synthetic-old']] : []);
  const messages: unknown[] = [],
    wire: Array<{ request: unknown; response: unknown }> = [];
  const changes = new GhostSetupChangeBus();
  const bridge = new GhostSetupInteractionBridge({ broadcast: (...args) => messages.push(args) });
  const manifest = (): GhostManifest => ({
    schemaVersion: 2,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    tools: [],
    network: {
      hosts: ['api.example.com'],
      secrets: [
        {
          key: 'api_key',
          label: 'API Key',
          source,
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        },
      ],
    },
  });
  const assess = (): GhostSetupAssessment => ({
    state: values.size ? 'ready' : 'required',
    revision: changes.currentRevision('demo'),
    groups: values.size && !options.saved
      ? []
      : [
          {
            id: 'credential',
            mode: 'any_of',
            items: [
              {
                ref: 'secret:api_key',
                kind: 'secret',
                label: 'API Key',
                state: values.size ? 'satisfied' : 'missing',
                actions: [inline],
              },
            ],
          },
        ],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempted = false;
  const store = vi.fn((ghost: string, key: string, value: string) => {
    if (options.failStore) return false;
    values.set(ghost + ':' + key, value);
    return true;
  });
  const coordinator = new GhostSetupCoordinator({
    bridge,
    changeBus: changes,
    assess,
    validateTarget: () => ({ ok: true }),
    getGhostIdentity: () => ({ id: 'demo', name: 'Demo' }),
    executeAction: async () => ({ ok: true }),
    executeInlineAction: async (args) => {
      attempted = true;
      if (options.holdStore) await gate;
      return executeGhostSetupInlineSubmission(
        {
          getAssessment: assess,
          getManifest: manifest,
          storeSecret: store,
          emitChange: () => {
            changes.emit('demo', { source: 'secret', ref: 'secret:api_key' });
          },
        },
        args,
      );
    },
    terminalGraceMs: 0,
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
  });
  const abort = new AbortController();
  const ready = coordinator.ensureReady({
    sessionId: 'task',
    ghostId: 'demo',
    signal: abort.signal,
    reauthorize: options.saved,
  });
  cleanups.push(() => {
    abort.abort();
    release();
  });
  await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
  const snapshot = bridge.pendingSnapshots()[0].request;
  const step = snapshot.steps[0];
  const action = {
    deviceId: 'cloud-device',
    ghostId: 'demo',
    requestId: snapshot.requestId,
    actionId: inline.id,
    expectedRevision: snapshot.revision,
  };
  const presentation = {
    ghostName: snapshot.ghost.name,
    title: step.title,
    description: step.description,
    intro: snapshot.intro ?? '',
    fieldLabel: 'API Key',
    fieldDescription: '',
    maxLength: 200,
  };
  const openExternal = vi.fn(async () => {
    throw new Error('input must not open a browser');
  });
  const deps: LocalOauthDeps = {
    owner: () => owner,
    assertTarget: (deviceId) => {
      if (deviceId !== 'cloud-device') throw new Error('target');
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
      const response = await requestPluginOauth('desktop', args[0]);
      wire.push({ request: args[0], response });
      return { ok: true, result: response };
    },
  };
  return {
    deps,
    action,
    presentation,
    bridge,
    ready,
    store,
    values,
    wire,
    messages,
    openExternal,
    release,
    attempted: () => attempted,
    abort,
    changeOwner: () => {
      owner = 'someone-else';
    },
    changeSource: () => {
      source = 'oauth';
    },
    submit: (override: Record<string, unknown> = {}) =>
      handleSubmitPluginSecret(deps, { ...action, value: input, presentation, ...override }),
  };
}

describe('signed remote inline setup through the actual Host executor', () => {
  it.each([false, true])('stores only the bound plugin key without exposing plaintext (reconfigure: %s)', async saved => {
    const h = await harness({ saved });
    await expect(h.submit()).resolves.toEqual({ accepted: true });
    await expect(h.ready).resolves.toMatchObject({ ok: true });
    expect(h.values).toEqual(new Map([['demo:api_key', input]]));
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(JSON.stringify([h.wire, h.messages])).not.toContain(input);
    // Replaying the same authenticated packet returns its old reply, never a second write.
    const exchanges = h.wire.filter((e) => (e.request as { op: string }).op === 'exchange');
    for (const entry of exchanges)
      await expect(requestPluginOauth('desktop', entry.request)).resolves.toEqual(entry.response);
    expect(h.store).toHaveBeenCalledTimes(1);
    await expect(requestPluginOauth('other-desktop', exchanges.at(-1)!.request)).rejects.toThrow();
  });

  it.each([
    'ghostName',
    'title',
    'description',
    'intro',
    'fieldLabel',
    'fieldDescription',
    'maxLength',
  ] as const)('refuses a changed displayed %s before transmitting the value', async (field) => {
    const h = await harness();
    await expect(
      h.submit({
        presentation: { ...h.presentation, [field]: field === 'maxLength' ? 199 : 'changed' },
      }),
    ).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
    expect(h.attempted()).toBe(false);
    expect(JSON.stringify([h.wire, h.messages])).not.toContain(input);
  });

  it.each([
    { ghostId: 'another-plugin' },
    { deviceId: 'other-device' },
    { expectedRevision: 100 },
    { actionId: 'another-field' },
    { value: 'x'.repeat(201) },
    { storageKey: 'forged' },
    { value: '' },
    { value: 'line\u0000break' },
  ])('rejects invalid or cross-target input %j', async (override) => {
    const h = await harness();
    await expect(h.submit(override)).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
  });

  it('does not turn ordinary assist into a secret request or open browser', async () => {
    const h = await harness();
    await expect(handleAssistPluginOauth(h.deps, h.action)).rejects.toThrow();
    expect(h.store).not.toHaveBeenCalled();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('refuses an old Host before sending input and clears the local pending value', async () => {
    const invoke = vi.fn(async () => ({
      version: 1,
      callback: 'desktop-loopback',
      encrypted: true,
    }));
    const deps = { invoke, secretValue: input, assertCurrent() {}, openExternal: vi.fn() };
    await expect(
      assistPluginOauth(deps, { requestId: 'card', actionId: 'action', expectedRevision: 0 }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledExactlyOnceWith({ op: 'capabilities' });
    expect(deps.secretValue).toBeUndefined();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it.each(['session', 'peer', 'owner', 'declaration'] as const)(
    'rejects a late store after %s changes',
    async (reason) => {
      const h = await harness({ holdStore: true, saved: true });
      const submitting = h.submit();
      const rejected = expect(submitting).rejects.toThrow();
      await vi.waitFor(() => expect(h.attempted()).toBe(true));
      if (reason === 'session') h.abort.abort();
      if (reason === 'peer') invalidatePluginOauth('desktop');
      if (reason === 'owner') h.changeOwner();
      if (reason === 'declaration') h.changeSource();
      h.release();
      await rejected;
      expect(h.store).not.toHaveBeenCalled();
      expect(h.values.get('demo:api_key')).toBe('synthetic-old');
    },
  );

  it('reports a vault write failure and leaves the card retryable', async () => {
    const h = await harness({ failStore: true, saved: true });
    await expect(h.submit()).rejects.toThrow();
    expect(h.values.get('demo:api_key')).toBe('synthetic-old');
    expect(h.bridge.pendingSnapshots()[0].request.steps[0]).toMatchObject({
      phase: 'failed',
      errorCode: 'SAVE_FAILED',
    });
    expect(JSON.stringify(h.messages)).not.toContain(input);
  });
});
