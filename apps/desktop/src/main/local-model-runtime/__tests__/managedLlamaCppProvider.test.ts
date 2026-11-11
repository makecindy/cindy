import { buildUserProvider, type CustomProviderConfig } from '@cindy/model-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({
  getCustomProvider: vi.fn(),
  createCustomProvider: vi.fn(),
  updateCustomProviderIfUnchanged: vi.fn(),
}));
vi.mock('../../maker-host/custom-provider-store.js', () => store);
import {
  buildManagedLlamaCppProvider,
  ensureManagedLlamaCppProvider,
  isManagedLlamaCppProvider,
  assertManagedLlamaCppProvider,
} from '../managedLlamaCppProvider.js';

// Match parseRuntimes's read order instead of returning the builder's object.
function storedConfig(config: CustomProviderConfig): CustomProviderConfig {
  const copy: CustomProviderConfig = JSON.parse(JSON.stringify(config));
  copy.runtimes = {
    'claude-code': copy.runtimes['claude-code'],
    codex: copy.runtimes.codex,
    pi: copy.runtimes.pi,
  };
  return copy;
}

describe('managed llama.cpp provider', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    { models: [] },
    { models: [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }] },
  ])('does not write an unchanged stored inventory: %j', async ({ models }) => {
    const existing = storedConfig(buildManagedLlamaCppProvider(models));
    store.getCustomProvider.mockResolvedValue(existing);
    expect(await ensureManagedLlamaCppProvider(models, () => true)).toBe(false);
    expect(store.updateCustomProviderIfUnchanged).not.toHaveBeenCalled();
    expect(store.createCustomProvider).not.toHaveBeenCalled();
  });

  it('ignores nested property order and preserves user settings during a real update', async () => {
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }];
    const existing = storedConfig(buildManagedLlamaCppProvider(models));
    existing.name = 'My local provider';
    for (const runtime of Object.values(existing.runtimes)) {
      runtime!.models[0] = {
        contextWindow: 65536,
        defaultEnabled: false,
        name: 'My model',
        id: 'model',
      };
    }
    store.getCustomProvider.mockResolvedValue(existing);
    expect(await ensureManagedLlamaCppProvider(models, () => true)).toBe(false);
    expect(store.updateCustomProviderIfUnchanged).not.toHaveBeenCalled();
    store.updateCustomProviderIfUnchanged.mockResolvedValue(true);
    const added = { id: 'new', repo: 'owner/new', file: 'b.gguf', size: 1 };
    expect(await ensureManagedLlamaCppProvider([...models, added], () => true)).toBe(true);
    expect(store.updateCustomProviderIfUnchanged).toHaveBeenCalledOnce();
    const [id, expected, next] = store.updateCustomProviderIfUnchanged.mock.calls[0]!;
    expect(id).toBe(existing.id);
    expect(expected).toBe(existing);
    expect(next.name).toBe('My local provider');
    for (const runtime of Object.values((next as CustomProviderConfig).runtimes)) {
      expect(runtime!.models[0]).toEqual(existing.runtimes.pi!.models[0]);
      expect(runtime!.models.map((model) => model.id)).toEqual(['model', 'new']);
    }
    expect(store.createCustomProvider).not.toHaveBeenCalled();
  });

  it('keeps model array order significant', async () => {
    const models = [
      { id: 'a', repo: 'owner/a', file: 'a.gguf', size: 1 },
      { id: 'b', repo: 'owner/b', file: 'b.gguf', size: 1 },
    ];
    const existing = storedConfig(buildManagedLlamaCppProvider(models));
    store.getCustomProvider.mockResolvedValue(existing);
    store.updateCustomProviderIfUnchanged.mockResolvedValue(true);
    expect(await ensureManagedLlamaCppProvider([...models].reverse(), () => true)).toBe(true);
    expect(store.updateCustomProviderIfUnchanged).toHaveBeenCalledOnce();
    const next = store.updateCustomProviderIfUnchanged.mock.calls[0]![2] as CustomProviderConfig;
    expect(next.runtimes.pi!.models.map((model) => model.id)).toEqual(['b', 'a']);
  });

  it('retains JSON equivalence for omitted and undefined properties', async () => {
    const existing = storedConfig(buildManagedLlamaCppProvider([]));
    existing.auth = { method: 'none', oauth: undefined };
    store.getCustomProvider.mockResolvedValue(existing);
    expect(await ensureManagedLlamaCppProvider([], () => true)).toBe(false);
    expect(store.updateCustomProviderIfUnchanged).not.toHaveBeenCalled();
  });

  it.each(['address', 'protocol', 'auth'] as const)(
    'rejects a real initial %s conflict',
    async (field) => {
      const existing = storedConfig(buildManagedLlamaCppProvider([]));
      if (field === 'address') existing.runtimes.pi!.baseUrl = 'https://example.test/v1';
      if (field === 'protocol') existing.runtimes.pi!.wireProtocol = 'openai-responses';
      if (field === 'auth') existing.auth = { method: 'apiKey' };
      store.getCustomProvider.mockResolvedValue(existing);
      await expect(ensureManagedLlamaCppProvider([], () => true)).rejects.toThrow(
        'PROVIDER_CONFLICT',
      );
      expect(store.updateCustomProviderIfUnchanged).not.toHaveBeenCalled();
      expect(store.createCustomProvider).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 3, 4])('stops when owner check %i fails', async (check) => {
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }];
    store.getCustomProvider.mockResolvedValue(storedConfig(buildManagedLlamaCppProvider([])));
    store.updateCustomProviderIfUnchanged.mockResolvedValue(false);
    let checks = 0;
    await expect(ensureManagedLlamaCppProvider(models, () => ++checks < check)).rejects.toThrow(
      'OWNER_CHANGED',
    );
    expect(store.getCustomProvider).toHaveBeenCalledTimes(check === 1 ? 0 : check === 4 ? 2 : 1);
    expect(store.updateCustomProviderIfUnchanged).toHaveBeenCalledTimes(check <= 2 ? 0 : 1);
    expect(store.createCustomProvider).not.toHaveBeenCalled();
  });
  it('rechecks the current stored connection and rejects missing or customized providers', async () => {
    const config = buildManagedLlamaCppProvider([]);
    store.getCustomProvider.mockResolvedValue(config);
    await expect(assertManagedLlamaCppProvider()).resolves.toBeUndefined();
    store.getCustomProvider.mockResolvedValue(null);
    await expect(assertManagedLlamaCppProvider()).rejects.toThrow('LOCAL_LLAMACPP_NOT_READY');
    config.runtimes.pi!.baseUrl = 'http://example.test/v1';
    store.getCustomProvider.mockResolvedValue(config);
    await expect(assertManagedLlamaCppProvider()).rejects.toThrow('LOCAL_LLAMACPP_NOT_READY');
    vi.resetAllMocks();
  });
  it.each([
    'published',
    'user-settings',
    'different-models',
    'deleted',
    'changed',
    'owner-changed',
  ] as const)('settles overlapping reconciliation after the winning write: %s', async (outcome) => {
    vi.resetAllMocks();
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }];
    const original = storedConfig(buildManagedLlamaCppProvider([]));
    let current: typeof original | null = original;
    let active = true;
    store.getCustomProvider.mockImplementation(async () => current);
    store.updateCustomProviderIfUnchanged.mockImplementation(async () => {
      if (current !== original) return false;
      current = outcome === 'deleted' ? null : storedConfig(buildManagedLlamaCppProvider(models));
      if (outcome === 'different-models') current = storedConfig(buildManagedLlamaCppProvider([]));
      if (outcome === 'user-settings') {
        current!.name = 'Concurrent rename';
        current!.runtimes.pi!.models[0] = {
          ...current!.runtimes.pi!.models[0]!,
          name: 'Concurrent model name',
          contextWindow: 65536,
          defaultEnabled: false,
        };
      }
      if (outcome === 'changed') current!.runtimes.pi!.baseUrl = 'https://example.test/v1';
      if (outcome === 'owner-changed') active = false;
      return true;
    });
    const results = await Promise.allSettled([
      ensureManagedLlamaCppProvider(models, () => active),
      ensureManagedLlamaCppProvider(models, () => active),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: true });
    if (outcome === 'published' || outcome === 'user-settings' || outcome === 'deleted')
      expect(results[1]).toEqual({ status: 'fulfilled', value: false });
    else
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: new Error(outcome === 'owner-changed' ? 'OWNER_CHANGED' : 'PROVIDER_CONFLICT'),
      });
    expect(store.createCustomProvider).not.toHaveBeenCalled();
    expect(store.updateCustomProviderIfUnchanged).toHaveBeenCalledTimes(
      outcome === 'owner-changed' ? 1 : 2,
    );
    if (outcome === 'user-settings') {
      expect(current!.name).toBe('Concurrent rename');
      expect(current!.runtimes.pi!.models[0]).toMatchObject({
        name: 'Concurrent model name',
        contextWindow: 65536,
        defaultEnabled: false,
      });
    }
    vi.resetAllMocks();
  });
  it('never recreates a removed provider during reconciliation or late completion', async () => {
    vi.clearAllMocks();
    store.getCustomProvider.mockResolvedValue(null);
    expect(await ensureManagedLlamaCppProvider([], () => true)).toBe(false);
    expect(store.createCustomProvider).not.toHaveBeenCalled();
    store.getCustomProvider.mockResolvedValue(buildManagedLlamaCppProvider([]));
    store.updateCustomProviderIfUnchanged.mockResolvedValue(false);
    await expect(
      ensureManagedLlamaCppProvider(
        [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }],
        () => true,
      ),
    ).rejects.toThrow('PROVIDER_CONFLICT');
    expect(store.createCustomProvider).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });
  it('reconciles installed files once and preserves owner settings', async () => {
    vi.clearAllMocks();
    const existing = buildManagedLlamaCppProvider([]);
    store.getCustomProvider.mockResolvedValue(existing);
    store.updateCustomProviderIfUnchanged.mockResolvedValue(true);
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 1 }];
    expect(await ensureManagedLlamaCppProvider(models, () => true)).toBe(true);
    store.getCustomProvider.mockResolvedValue(buildManagedLlamaCppProvider(models, existing));
    expect(await ensureManagedLlamaCppProvider(models, () => true)).toBe(false);
    expect(store.updateCustomProviderIfUnchanged).toHaveBeenCalledOnce();
    await expect(ensureManagedLlamaCppProvider(models, () => false)).rejects.toThrow(
      'OWNER_CHANGED',
    );
    vi.clearAllMocks();
  });
  it('upgrades the Flash-Next trial budget across engines, preserving other models and custom settings', () => {
    const models = [
      { id: 'flash', repo: 'bartowski/Qwen3.8-Flash-Next-GGUF', file: 'a.gguf', size: 1 },
      { id: 'other', repo: 'other/model', file: 'a.gguf', size: 1 },
    ];
    const previous = buildManagedLlamaCppProvider(models);
    for (const runtime of Object.values(previous.runtimes))
      runtime!.models[0]!.contextWindow = 32768;
    previous.runtimes.pi!.models[0]!.name = 'My Flash';
    const updated = buildManagedLlamaCppProvider(models, previous);
    for (const runtime of Object.values(updated.runtimes)) {
      expect(runtime!.models.map((model) => model.contextWindow)).toEqual([262144, 32768]);
    }
    expect(updated.runtimes.pi!.models[0]!.name).toBe('My Flash');
    const projected = buildUserProvider(updated);
    expect(projected.models.pi?.find((model) => model.id === 'flash')).toMatchObject({
      contextWindow: 262144,
      contextWindowMax: 1_000_000,
      contextWindowVerified: true,
    });
    previous.runtimes.pi!.models[0]!.contextWindow = 65536;
    expect(
      buildManagedLlamaCppProvider(models, previous).runtimes.pi!.models[0]!.contextWindow,
    ).toBe(65536);
  });
  it('creates an empty provider and preserves models when added again', async () => {
    store.getCustomProvider.mockResolvedValue(null);
    await ensureManagedLlamaCppProvider(undefined, () => true);
    expect(store.createCustomProvider).toHaveBeenCalledWith(buildManagedLlamaCppProvider([]));
    const existing = buildManagedLlamaCppProvider([
      { id: 'model', repo: 'owner/model', file: 'a.gguf', size: 1 },
    ]);
    store.getCustomProvider.mockResolvedValue(existing);
    await ensureManagedLlamaCppProvider(undefined, () => true);
    expect(store.updateCustomProviderIfUnchanged).not.toHaveBeenCalled();
    expect(store.createCustomProvider).toHaveBeenCalledOnce();
  });
  it('exposes downloaded models through the supported Chat bridge and keeps user model settings', () => {
    const models = [{ id: 'model-abc', repo: 'owner/model', file: 'model.gguf', size: 1 }];
    const catalog = [
      {
        id: 'model',
        name: 'Shared catalog name',
        aliases: [],
        variants: [
          {
            repo: 'owner/model',
            file: 'model.gguf',
            sizeBytes: 1,
            quantization: 'Q4',
            verifiedAt: '2026-09-25',
          },
        ],
      },
    ];
    const provider = buildManagedLlamaCppProvider(models, undefined, catalog);
    expect(provider.runtimes.pi!.models[0]!.name).toBe('Shared catalog name');
    expect(isManagedLlamaCppProvider(provider)).toBe(true);
    expect(Object.keys(provider.runtimes)).toEqual(['pi', 'codex', 'claude-code']);
    provider.runtimes.pi!.models[0]!.name = 'My model';
    provider.runtimes.pi!.models[0]!.defaultEnabled = false;
    const updated = buildManagedLlamaCppProvider(models, provider);
    expect(updated.runtimes.pi!.models[0]).toMatchObject({
      name: 'My model',
      defaultEnabled: false,
    });
    provider.runtimes.pi!.baseUrl = 'https://example.test/v1';
    expect(isManagedLlamaCppProvider(provider)).toBe(false);
  });
});
