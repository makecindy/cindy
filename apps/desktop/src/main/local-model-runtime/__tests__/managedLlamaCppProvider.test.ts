import { buildUserProvider } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';
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
} from '../managedLlamaCppProvider.js';

describe('managed llama.cpp provider', () => {
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
      contextWindow: 262144, contextWindowMax: 1_000_000, contextWindowVerified: true,
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
