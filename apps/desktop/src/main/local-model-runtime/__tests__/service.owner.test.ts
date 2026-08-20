import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../managedOllamaProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managedOllamaProvider.js')>();
  return {
    ...actual,
    readManagedOllamaProvider: vi.fn(async () => actual.buildEmptyManagedOllamaProvider()),
    syncManagedOllamaAgentProjections: vi.fn(async (_agents, opts) => {
      if (opts?.stillActive && !opts.stillActive()) return false;
      return false;
    }),
    upsertManagedOllamaModel: vi.fn(async (_model, _agents, opts) => {
      if (opts?.stillActive && !opts.stillActive()) return { ok: false, code: 'OWNER_CHANGED' };
      return {
        ok: true,
        created: true,
        provider: actual.buildEmptyManagedOllamaProvider(),
      };
    }),
    upsertManagedOllamaModels: vi.fn(async (_entries, opts) => {
      if (opts?.stillActive && !opts.stillActive()) return { ok: false, code: 'OWNER_CHANGED' };
      return {
        ok: true,
        created: false,
        provider: actual.buildEmptyManagedOllamaProvider(),
      };
    }),
  };
});

import { createLocalModelService, OwnerChangedError } from '../service.js';
import {
  readManagedOllamaProvider,
  syncManagedOllamaAgentProjections,
  upsertManagedOllamaModel,
  upsertManagedOllamaModels,
} from '../managedOllamaProvider.js';

function readyFetch(models: string[] = ['gpt-oss:20b']) {
  return async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/api/tags')) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }));
    }
    return new Response(JSON.stringify({ version: '0.32.14' }));
  };
}

describe('owner change during pull', () => {
  beforeEach(() => {
    vi.mocked(upsertManagedOllamaModel).mockClear();
    vi.mocked(upsertManagedOllamaModels).mockClear();
    vi.mocked(readManagedOllamaProvider).mockClear();
    vi.mocked(syncManagedOllamaAgentProjections).mockClear();
  });

  it('does not upsert or import a pull finished after the account switched', async () => {
    const service = createLocalModelService({
      streamPull: async () => undefined,
      pausedPullStore: {
        read: async () => null,
        readSync: () => null,
        readAll: async () => [],
        readAllSync: () => [],
        write: async () => undefined,
        remove: async () => null,
        clear: async () => undefined,
      },
      fetchImpl: readyFetch(),
    });

    await expect(
      service.pull('gpt-oss:20b', {
        owner: { dataOwnerId: 'alice', generation: 1 },
        ownerStillActive: () => false,
      }),
    ).rejects.toBeInstanceOf(OwnerChangedError);
    expect(upsertManagedOllamaModel).toHaveBeenCalled();
    expect(await vi.mocked(upsertManagedOllamaModel).mock.results.at(-1)?.value).toMatchObject({
      ok: false,
      code: 'OWNER_CHANGED',
    });

    await service.list({ owner: { dataOwnerId: 'bob', generation: 2 } });
    const importedByBob = vi.mocked(upsertManagedOllamaModels).mock.calls.flatMap(
      ([entries]) => entries.map((entry) => entry.model.id),
    );
    expect(importedByBob).not.toContain('gpt-oss:20b');

    vi.mocked(upsertManagedOllamaModels).mockClear();
    await service.list({ owner: { dataOwnerId: 'alice', generation: 1 } });
    const importedByAlice = vi.mocked(upsertManagedOllamaModels).mock.calls.flatMap(
      ([entries]) => entries.map((entry) => entry.model.id),
    );
    expect(importedByAlice).toContain('gpt-oss:20b');
  });

  it('does not recreate a deleted managed Ollama provider just by listing tags', async () => {
    vi.mocked(readManagedOllamaProvider).mockResolvedValueOnce(null);
    const service = createLocalModelService({
      fetchImpl: readyFetch(),
    });
    await service.list();
    expect(upsertManagedOllamaModels).not.toHaveBeenCalled();
  });

  it('does not import tags after the account switched during list', async () => {
    const service = createLocalModelService({
      fetchImpl: readyFetch(),
    });
    await service.list({
      owner: { dataOwnerId: 'alice', generation: 1 },
      ownerStillActive: () => false,
    });
    expect(upsertManagedOllamaModels).not.toHaveBeenCalled();
  });

  it('passes the captured owner into projection sync during list', async () => {
    const service = createLocalModelService({
      fetchImpl: readyFetch(),
    });
    await service.list({
      owner: { dataOwnerId: 'alice', generation: 1 },
      ownerStillActive: () => false,
    });
    expect(syncManagedOllamaAgentProjections).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stillActive: expect.any(Function) }),
    );
    const opts = vi.mocked(syncManagedOllamaAgentProjections).mock.calls[0]?.[1];
    expect(opts?.stillActive?.()).toBe(false);
  });
});
