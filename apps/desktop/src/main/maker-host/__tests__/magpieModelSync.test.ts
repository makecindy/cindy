import { describe, expect, it, vi } from 'vitest';

import type {
  CustomProviderConfig,
  DiscoveredModel,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

import type { ProviderModelsFetchResult, ProviderModelsFetchSpec } from '../provider-model-fetch.js';
import {
  createMagpieModelSyncCoordinator,
  configureMagpieModelSync,
  requestMagpieModelSyncAfterChange,
  syncMagpieProviderNow,
  type MagpieModelSyncDeps,
  type MagpieSyncStatusState,
  type MagpieSyncStatusStore,
} from '../magpie-model-sync.js';

const ORIGIN = 'http://127.0.0.1:3425';

function memoryStore(): MagpieSyncStatusStore & { state: Map<string, MagpieSyncStatusState> } {
  const state = new Map<string, MagpieSyncStatusState>();
  return {
    state,
    read: (providerId) => state.get(providerId),
    write: (providerId, next) => {
      state.set(providerId, next);
    },
  };
}

function configWith(model: ProviderRuntimeModelConfig): CustomProviderConfig {
  return {
    id: 'magpie',
    name: 'Magpie',
    runtimes: {
      'claude-code': {
        catalogPresetId: 'magpie',
        baseUrl: ORIGIN,
        wireProtocol: 'anthropic-messages',
        modelsUrl: `${ORIGIN}/v1/models`,
        models: [model],
      },
      codex: {
        catalogPresetId: 'magpie',
        baseUrl: `${ORIGIN}/v1`,
        wireProtocol: 'openai-responses',
        modelsUrl: `${ORIGIN}/v1/models`,
        models: [model],
      },
      pi: {
        catalogPresetId: 'magpie',
        baseUrl: `${ORIGIN}/v1`,
        wireProtocol: 'openai-chat',
        modelsUrl: `${ORIGIN}/v1/models`,
        models: [model],
      },
    },
  };
}

function discovered(id: string, nativeEndpoints?: string[]): DiscoveredModel {
  return {
    id,
    name: id,
    opaqueModelId: true,
    discoveredSource: { kind: 'magpie', providerId: 'workbuddy' },
    ...(nativeEndpoints ? { nativeEndpoints } : {}),
  };
}

function harness(initial: CustomProviderConfig, response: (spec: ProviderModelsFetchSpec) => ProviderModelsFetchResult | Promise<ProviderModelsFetchResult>) {
  let config: CustomProviderConfig | null = structuredClone(initial);
  const status = memoryStore();
  let now = 1_000_000;
  let scope = 1;
  const getConfig = vi.fn(async (): Promise<CustomProviderConfig | null> => config ? structuredClone(config) : null);
  const fetchModels = vi.fn(async (spec: ProviderModelsFetchSpec) => response(spec));
  const refreshCatalog = vi.fn(async (): Promise<void> => undefined);
  const broadcastChanged = vi.fn(() => ({ scope, state: structuredClone(status.read('magpie')) }));
  const updateConfigIfUnchanged = vi.fn(async (
    _id: string,
    expected: CustomProviderConfig,
    next: CustomProviderConfig,
  ) => {
    if (!config || JSON.stringify(config) !== JSON.stringify(expected)) return false;
    config = structuredClone(next);
    return true;
  });
  const deps: MagpieModelSyncDeps = {
    listConfigs: async () => (config ? [structuredClone(config)] : []),
    getConfig,
    readKey: (_id, agent) => `gateway-${agent}`,
    fetchModels,
    updateConfigIfUnchanged,
    refreshCatalog,
    broadcastChanged,
    getScopeKey: () => scope,
    appVersion: '1.2.3',
    now: () => now,
    log: { debug: vi.fn(), warn: vi.fn() },
    statusStore: status,
  };
  const coordinator = createMagpieModelSyncCoordinator(deps);
  return {
    deps,
    coordinator,
    getConfig,
    fetchModels,
    status,
    refreshCatalog,
    broadcastChanged,
    current: () => config!,
    setConfig: (next: CustomProviderConfig) => { config = structuredClone(next); },
    setNow: (value: number) => {
      now = value;
    },
    setScope: (value: number) => { scope = value; },
  };
}

describe('Magpie model synchronization', () => {
  it.each([true, false])('syncs the latest saved endpoint after the pending request settles (old success: %s)', async (oldSucceeds) => {
    const initial = configWith({ id: 'existing', name: 'Existing' });
    initial.runtimes = { codex: initial.runtimes.codex };
    let finishOld!: (result: ProviderModelsFetchResult) => void;
    let notifyStarted!: () => void;
    const pending = new Promise<ProviderModelsFetchResult>((resolve) => { finishOld = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const setup = harness(initial, (spec) => {
      if (spec.baseUrl === initial.runtimes.codex!.baseUrl) {
        notifyStarted();
        return pending;
      }
      return { ok: true, models: [discovered('fresh', ['/v1/responses'])] };
    });
    configureMagpieModelSync(setup.deps);
    const old = syncMagpieProviderNow('magpie');
    await started;
    const edited = structuredClone(initial);
    edited.runtimes.codex!.baseUrl = 'http://127.0.0.1:3426/v1';
    edited.runtimes.codex!.modelsUrl = 'http://127.0.0.1:3426/v1/models';
    setup.setConfig(edited);
    const firstSave = requestMagpieModelSyncAfterChange('magpie');
    edited.runtimes.codex!.baseUrl = 'http://127.0.0.1:3427/v1';
    edited.runtimes.codex!.modelsUrl = 'http://127.0.0.1:3427/v1/models';
    setup.setConfig(edited);
    const secondSave = requestMagpieModelSyncAfterChange('magpie');
    finishOld(oldSucceeds
      ? { ok: true, models: [discovered('obsolete', ['/v1/responses'])] }
      : { ok: false, code: 'UPSTREAM_UNREACHABLE' });
    await Promise.all([old, firstSave, secondSave]);
    expect(setup.fetchModels.mock.calls.map(([spec]) => spec.baseUrl)).toEqual([
      initial.runtimes.codex!.baseUrl, edited.runtimes.codex!.baseUrl,
    ]);
    expect(setup.current().runtimes.codex!.models.map((model) => model.id).sort()).toEqual(['existing', 'fresh']);
    expect(setup.coordinator.getStatus('magpie').failure).toBeNull();
  });

  it('notifies after writing a missing-runtime status without refreshing the catalog', async () => {
    const setup = harness({ ...configWith({ id: 'existing', name: 'Existing' }), runtimes: {} }, () => ({ ok: true, models: [] }));
    await setup.coordinator.requestAutoRefresh('startup');
    expect(setup.broadcastChanged).toHaveBeenCalledTimes(1);
    expect(setup.broadcastChanged.mock.results[0].value).toMatchObject({ scope: 1, state: { failure: { code: 'NOT_CONFIGURED' } } });
    expect(setup.refreshCatalog).not.toHaveBeenCalled();
  });

  it('does not defer a status notification across an owner change during catalog refresh', async () => {
    const setup = harness(configWith({ id: 'existing', name: 'Existing' }), () => ({ ok: true, models: [] }));
    let finishCatalog!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    setup.refreshCatalog.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCatalog = resolve;
      notifyStarted();
    }));
    const pending = setup.coordinator.syncNow('magpie');
    await started;
    const notifiedScopes = setup.broadcastChanged.mock.results.map((result) => result.value.scope);
    setup.setScope(2);
    finishCatalog();
    await pending;
    expect(notifiedScopes).toEqual([1]);
    expect(setup.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('does not write status after the owner changes while loading the connection', async () => {
    const setup = harness(configWith({ id: 'existing', name: 'Existing' }), () => ({ ok: true, models: [] }));
    let finish!: (config: CustomProviderConfig) => void;
    setup.getConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = setup.coordinator.syncNow('magpie');
    setup.setScope(2);
    finish({ ...configWith({ id: 'former', name: 'Former' }), runtimes: {} });
    expect(await pending).toMatchObject({ ok: false, code: 'CONFIG_CHANGED' });
    expect(setup.status.state.size).toBe(0);
    expect(setup.fetchModels).not.toHaveBeenCalled();
  });

  it('joins automatic and manual requests already reading the same connection', async () => {
    let finish!: (result: ProviderModelsFetchResult) => void;
    const pending = new Promise<ProviderModelsFetchResult>((resolve) => { finish = resolve; });
    const setup = harness(configWith({ id: 'existing', name: 'Existing' }), () => pending);
    const first = setup.coordinator.syncNow('magpie');
    const automatic = setup.coordinator.requestAutoRefresh('providers-open');
    const second = setup.coordinator.syncNow('magpie');
    finish({ ok: true, models: [discovered('new', ['/v1/messages'])] });
    const results = await Promise.all([first, second, automatic]);
    expect(results[0]).toMatchObject({ ok: true, added: 1 });
    expect(results[1]).toEqual(results[0]);
    expect(setup.fetchModels).toHaveBeenCalledTimes(3);
  });

  it('does not apply or publish a former owner result after the new scope has synchronized', async () => {
    let finishOld!: (result: ProviderModelsFetchResult) => void;
    let notifyStarted!: () => void;
    const pending = new Promise<ProviderModelsFetchResult>((resolve) => { finishOld = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let requests = 0;
    const setup = harness(configWith({ id: 'existing', name: 'Existing' }), () => {
      requests += 1;
      if (requests === 1) {
        notifyStarted();
        return pending;
      }
      return { ok: true, models: [discovered('current', ['/v1/messages'])] };
    });
    configureMagpieModelSync(setup.deps);
    const old = syncMagpieProviderNow('magpie');
    await started;
    const afterSave = requestMagpieModelSyncAfterChange('magpie');
    setup.setScope(2);
    const current = await syncMagpieProviderNow('magpie');
    finishOld({ ok: true, models: [discovered('former-owner', ['/v1/messages'])] });
    expect(await old).toMatchObject({ ok: false, code: 'CONFIG_CHANGED' });
    await afterSave;
    expect(setup.fetchModels).toHaveBeenCalledTimes(4);
    expect(setup.broadcastChanged).toHaveBeenCalledTimes(1);
    expect(setup.broadcastChanged.mock.results[0].value.scope).toBe(2);
    expect(setup.coordinator.getStatus('magpie')).toEqual(current.status);
    for (const runtime of Object.values(setup.current().runtimes)) {
      expect(runtime?.models.map((model) => model.id).sort()).toEqual(['current', 'existing']);
    }
  });

  it('adds models without removing history or user routing, and routes only new ids', async () => {
    const existing: ProviderRuntimeModelConfig = {
      id: 'claude/claude-opus-5-5',
      name: 'Claude Opus 5.5',
      defaultEnabled: false,
      nameExplicit: true,
      route: { baseUrl: ORIGIN, wireProtocol: 'anthropic-messages' },
    };
    const historic: ProviderRuntimeModelConfig = { id: 'retired/model', name: 'Retired' };
    const initial = configWith(existing);
    for (const runtime of Object.values(initial.runtimes)) runtime!.models.push({ ...historic });
    const h = harness(initial, () => ({
      ok: true,
      models: [
        discovered(existing.id, ['/v1/messages']),
        discovered('workbuddy/new-chat', ['/v1/chat/completions']),
        discovered('workbuddy/new-responses', ['/v1/responses']),
      ],
    }));

    const result = await h.coordinator.syncNow('magpie');

    expect(result.ok).toBe(true);
    expect(result.added).toBe(2);
    expect(result.status.lastSuccessAt).not.toBeNull();
    expect(result.status.failure).toBeNull();
    const config = h.current();
    expect(h.fetchModels).toHaveBeenCalledTimes(3);
    for (const call of h.fetchModels.mock.calls) {
      expect(call[0]).toMatchObject({ headers: { 'User-Agent': 'Cindy/1.2.3' } });
    }
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const models = config.runtimes[agent]!.models;
      // Historic and user-edited ids remain; existing routing is untouched.
      expect(models.some((model) => model.id === 'retired/model')).toBe(true);
      expect(models.find((model) => model.id === existing.id)).toMatchObject({
        defaultEnabled: false,
        nameExplicit: true,
        route: { baseUrl: ORIGIN, wireProtocol: 'anthropic-messages' },
      });
      // Chat is not served on the Responses-native runtime; route it explicitly.
      const chat = models.find((model) => model.id === 'workbuddy/new-chat');
      expect(chat?.route).toEqual(
        agent === 'pi'
          ? undefined
          : { baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-chat' },
      );
      const responses = models.find((model) => model.id === 'workbuddy/new-responses');
      expect(responses?.route).toEqual(
        agent === 'codex'
          ? undefined
          : { baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-responses' },
      );
    }
  });

  it('fills a missing native route on an existing model without touching user fields', async () => {
    const existing: ProviderRuntimeModelConfig = {
      id: 'workbuddy/old-chat',
      name: 'Old Chat',
      defaultEnabled: false,
    };
    const h = harness(configWith(existing), () => ({
      ok: true,
      models: [discovered(existing.id, ['/v1/chat/completions'])],
    }));

    const result = await h.coordinator.syncNow('magpie');

    expect(result.ok).toBe(true);
    expect(result.added).toBe(0);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const model = h.current().runtimes[agent]!.models.find((row) => row.id === existing.id)!;
      expect(model.defaultEnabled).toBe(false);
      expect(model.route).toEqual(
        agent === 'pi'
          ? undefined
          : { baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-chat' },
      );
    }
  });

  it('keeps the last successful list and marks staleness when a later sync fails', async () => {
    let ok = true;
    const h = harness(configWith({ id: 'claude/claude-opus-5-5', name: 'Claude Opus 5.5' }), () => (
      ok
        ? { ok: true, models: [discovered('claude/claude-opus-5-5', ['/v1/messages'])] }
        : { ok: false, code: 'UPSTREAM_UNREACHABLE', status: 502 }
    ));

    const first = await h.coordinator.syncNow('magpie');
    expect(first.ok).toBe(true);
    const modelsAfterSuccess = h.current().runtimes.pi!.models.map((model) => model.id);

    ok = false;
    h.setNow(3_000_000);
    await h.coordinator.requestAutoRefresh('providers-open');
    const failed = h.coordinator.getStatus('magpie');

    expect(failed.failure).toMatchObject({ code: 'UPSTREAM_UNREACHABLE', status: 502 });
    expect(failed.lastSuccessAt).toBe(first.status.lastSuccessAt);
    expect(failed.stale).toBe(true);
    expect(h.current().runtimes.pi!.models.map((model) => model.id)).toEqual(modelsAfterSuccess);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(2);
    expect(h.broadcastChanged.mock.results[1].value.state).toEqual(h.status.read('magpie'));
    expect(h.refreshCatalog).toHaveBeenCalledTimes(1);

    ok = true;
    h.setNow(3_400_000);
    await h.coordinator.requestAutoRefresh('providers-open');
    expect(h.broadcastChanged).toHaveBeenCalledTimes(3);
    expect(h.broadcastChanged.mock.results[2].value.state.failure).toBeNull();
    expect(h.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it('honors the automatic cooldown but lets startup and explicit sync through', async () => {
    const h = harness(configWith({ id: 'claude/claude-opus-5-5', name: 'Claude Opus 5.5' }), () => ({
      ok: true,
      models: [discovered('claude/claude-opus-5-5', ['/v1/messages'])],
    }));

    await h.coordinator.syncNow('magpie');
    expect(h.fetchModels).toHaveBeenCalledTimes(3);

    h.setNow(1_060_000);
    await h.coordinator.requestAutoRefresh('providers-open');
    expect(h.fetchModels).toHaveBeenCalledTimes(3);

    // Startup is forced once the persisted attempt is older than the dedupe window.
    h.setNow(1_300_000);
    await h.coordinator.requestAutoRefresh('startup');
    expect(h.fetchModels).toHaveBeenCalledTimes(6);

    // A second startup trigger within a minute does not hit the gateway again.
    await h.coordinator.requestAutoRefresh('startup');
    expect(h.fetchModels).toHaveBeenCalledTimes(6);

    await h.coordinator.syncNow('magpie');
    expect(h.fetchModels).toHaveBeenCalledTimes(9);
  });
});
