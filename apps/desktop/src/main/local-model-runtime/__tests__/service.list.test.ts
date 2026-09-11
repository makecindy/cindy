import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';

vi.mock('../../maker-host/custom-provider-store.js', () => ({
  createCustomProvider: vi.fn(),
  getCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
}));
vi.mock('../localConnectDetect.js', () => ({ detectLocalConnectPresets: async () => [] }));

import { getCustomProvider, updateCustomProvider } from '../../maker-host/custom-provider-store.js';
import {
  buildEmptyManagedOllamaProvider,
  upsertManagedOllamaModels,
} from '../managedOllamaProvider.js';
import { createLocalModelService } from '../service.js';

// Real service and projection logic, with only persistence and Ollama I/O replaced.
describe('Ollama list refresh convergence', () => {
  let provider: CustomProviderConfig;
  let toolsSupported: boolean;
  let tagsFail: boolean;
  const model = 'test-tools:latest';
  const pausedPullStore = {
    read: async () => null,
    readSync: () => null,
    readAll: async () => [],
    readAllSync: () => [],
    write: async () => undefined,
    remove: async () => null,
    clear: async () => undefined,
  };
  const makeService = () =>
    createLocalModelService({
      platform: 'darwin',
      arch: 'arm64',
      totalmem: () => 128 * 1024 ** 3,
      pausedPullStore,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/tags')) {
          if (tagsFail) throw new Error('temporarily unavailable');
          return new Response(JSON.stringify({ models: [{ name: model, size: 1024 }] }));
        }
        if (String(url).endsWith('/api/show')) {
          return new Response(JSON.stringify({ capabilities: toolsSupported ? ['tools'] : [] }));
        }
        return new Response(JSON.stringify({ version: '0.32.14' }));
      },
      streamPull: async (_name, _onEvent, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    provider = buildEmptyManagedOllamaProvider();
    toolsSupported = true;
    tagsFail = false;
    vi.mocked(getCustomProvider).mockImplementation(async () => provider);
    vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => {
      // Persistence reconstructs objects in its own key order. Compare values,
      // not the insertion order of JSON keys (including nested model metadata).
      const reorder = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reorder);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, reorder(item)]),
          );
        }
        return value;
      };
      provider = reorder(next) as CustomProviderConfig;
      return provider;
    });
  });

  it('settles after one import instead of broadcasting changes forever', async () => {
    const service = makeService();
    expect((await service.list()).catalogDirty).toBe(true);
    vi.mocked(updateCustomProvider).mockClear();
    for (let i = 0; i < 3; i++) {
      const result = await service.list();
      expect(result.catalogDirty).toBe(false);
      expect(result.memoryGb).toBe(128);
      expect(provider.runtimes.codex?.models.map((entry) => entry.id)).toEqual([model]);
    }
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });

  it('keeps coding models and hardware information stable during a pull', async () => {
    const service = makeService();
    await service.list();
    const pull = service.pull('another-model:latest').catch(() => undefined);
    try {
      await vi.waitFor(() => expect(service.activePulls()).toHaveLength(1));
      vi.mocked(updateCustomProvider).mockClear();
      for (let i = 0; i < 3; i++) {
        const result = await service.list();
        expect(result.status.kind).toBe('pulling');
        expect(result.catalogDirty).toBe(false);
        expect(result.memoryGb).toBe(128);
        expect(result.pulls[0]?.name).toBe('another-model:latest');
      }
      expect(updateCustomProvider).not.toHaveBeenCalled();
    } finally {
      await service.abortPull('pause', 'another-model:latest');
      await pull;
    }
  });

  it('retains projections on tags failure, but applies a real capabilities change once', async () => {
    const service = makeService();
    await service.list();
    vi.mocked(updateCustomProvider).mockClear();
    tagsFail = true;
    expect((await service.list()).catalogDirty).toBe(false);
    expect(updateCustomProvider).not.toHaveBeenCalled();
    expect(provider.runtimes.codex?.models).toHaveLength(1);
    tagsFail = false;
    toolsSupported = false;
    expect((await service.list()).catalogDirty).toBe(true);
    expect(provider.runtimes.codex?.models).toHaveLength(0);
    expect((await service.list()).catalogDirty).toBe(false);
    expect(updateCustomProvider).toHaveBeenCalledTimes(1);
  });

  it('reports a legacy migration even if the subsequent upsert is unchanged', async () => {
    provider.runtimes = { pi: provider.runtimes.pi! };
    expect(await upsertManagedOllamaModels([])).toMatchObject({ ok: true, changed: true });
    expect(await upsertManagedOllamaModels([])).toMatchObject({ ok: true, changed: false });
  });
});
