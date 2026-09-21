import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../maker-host/custom-provider-store.js', () => ({
  createCustomProvider: vi.fn(),
  getCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

import {
  createCustomProvider,
  getCustomProvider,
  updateCustomProvider,
} from '../../maker-host/custom-provider-store.js';
import {
  buildEmptyManagedOllamaProvider,
  emptyClaudeRuntime,
  emptyCodexRuntime,
  emptyPiRuntime,
  ensureManagedOllamaProvider,
  migrateManagedOllamaProvider,
  removeManagedOllamaModel,
  syncManagedOllamaAgentProjections,
  upsertManagedOllamaModel,
  upsertManagedOllamaModels,
  toPlainRuntimeModel,
} from '../managedOllamaProvider.js';

function providerWith(id: string) {
  const model = { id, name: id };
  return {
    ...buildEmptyManagedOllamaProvider(),
    runtimes: {
      pi: emptyPiRuntime([model]),
      'claude-code': emptyClaudeRuntime([model]),
      codex: emptyCodexRuntime([model]),
    },
  };
}

describe('managed Ollama model identity', () => {
  beforeEach(() => {
    vi.mocked(getCustomProvider).mockReset();
    vi.mocked(updateCustomProvider).mockReset();
    vi.mocked(createCustomProvider).mockReset();
  });

  it('replaces an untagged model with its :latest alias instead of duplicating', async () => {
    const existing = providerWith('glm-4.7-flash');
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => next);
    await upsertManagedOllamaModel({
      id: 'glm-4.7-flash:latest',
      name: 'glm-4.7-flash:latest',
    });
    const saved = vi.mocked(updateCustomProvider).mock.calls.at(-1)?.[1] as ReturnType<
      typeof providerWith
    >;
    expect(saved.runtimes.pi?.models.map((model) => model.id)).toEqual(['glm-4.7-flash:latest']);
    expect(saved.runtimes['claude-code']?.models.map((model) => model.id)).toEqual([
      'glm-4.7-flash:latest',
    ]);
    expect(saved.runtimes.codex?.models.map((model) => model.id)).toEqual(['glm-4.7-flash:latest']);
  });

  it('drops models absent from a successful tags snapshot', async () => {
    const existing = providerWith('gone-local');
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => next);
    await upsertManagedOllamaModels(
      [{ model: { id: 'kept-local:latest', name: 'kept-local:latest' } }],
      { retainCanonicalIds: new Set(['kept-local:latest']) },
    );
    const saved = vi.mocked(updateCustomProvider).mock.calls.at(-1)?.[1] as ReturnType<
      typeof providerWith
    >;
    expect(saved.runtimes.pi?.models.map((model) => model.id)).toEqual(['kept-local:latest']);
    expect(saved.runtimes.pi?.models.map((model) => model.id)).not.toContain('gone-local');
  });

  it.each(['Remote catalog name', 'glm-4.7-flash:latest'])(
    'preserves the resolved name %s through import and projection sync',
    async (name) => {
      let existing = providerWith('glm-4.7-flash:latest');
      vi.mocked(getCustomProvider).mockImplementation(async () => existing);
      vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => {
        existing = next as typeof existing;
        return next;
      });
      await upsertManagedOllamaModel({ id: 'glm-4.7-flash:latest', name });
      for (const runtime of Object.values(existing.runtimes)) {
        expect(runtime.models[0].name).toBe(name);
      }
      await syncManagedOllamaAgentProjections();
      for (const runtime of Object.values(existing.runtimes)) {
        expect(runtime.models[0].name).toBe(name);
      }
    },
  );

  it('does not write when the captured owner is no longer active', async () => {
    const existing = providerWith('glm-4.7-flash');
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    const result = await upsertManagedOllamaModels(
      [{ model: { id: 'glm-4.7-flash:latest', name: 'glm-4.7-flash:latest' } }],
      { stillActive: () => false },
    );
    expect(result).toEqual({ ok: false, code: 'OWNER_CHANGED' });
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });

  it('keeps an explicitly chosen raw ID name through import and later catalog loads', async () => {
    const id = 'hf.co/team/Example-GGUF:Q8_0';
    let existing = buildEmptyManagedOllamaProvider();
    vi.mocked(getCustomProvider).mockImplementation(async () => existing);
    vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => {
      existing = next;
      return next;
    });
    await upsertManagedOllamaModel({ id, name: id, nameExplicit: true });
    for (const runtime of Object.values(existing.runtimes)) {
      expect(runtime.models[0]).toMatchObject({ id, name: id, nameExplicit: true });
    }
    expect(migrateManagedOllamaProvider(existing)).toBe(existing);
  });

  it('does not create a managed provider after the captured owner is gone', async () => {
    let checks = 0;
    vi.mocked(getCustomProvider).mockResolvedValue(null);
    const result = await ensureManagedOllamaProvider({
      stillActive: () => {
        checks += 1;
        return checks < 2;
      },
    });
    expect(result).toEqual({ ok: false, code: 'OWNER_CHANGED' });
    expect(getCustomProvider).toHaveBeenCalled();
    expect(createCustomProvider).not.toHaveBeenCalled();
  });

  it('removes a model from coding agents when the replacement lacks tools', async () => {
    const existing = providerWith('glm-4.7-flash');
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    vi.mocked(updateCustomProvider).mockImplementation(async (_id, next) => next);
    await upsertManagedOllamaModel({ id: 'glm-4.7-flash', name: 'GLM' }, ['pi']);
    const saved = vi.mocked(updateCustomProvider).mock.calls.at(-1)?.[1] as ReturnType<
      typeof providerWith
    >;
    expect(saved.runtimes.pi?.models.map((model) => model.id)).toEqual(['glm-4.7-flash']);
    expect(saved.runtimes['claude-code']?.models).toEqual([]);
    expect(saved.runtimes.codex?.models).toEqual([]);
  });

  it('does not delete a managed model after the captured owner is gone', async () => {
    const existing = providerWith('glm-4.7-flash');
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    const result = await removeManagedOllamaModel('glm-4.7-flash', {
      stillActive: () => false,
    });
    expect(result).toEqual({ ok: false, code: 'OWNER_CHANGED' });
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });

  it('does not sync coding-agent projections after the captured owner is gone', async () => {
    const existing = {
      ...buildEmptyManagedOllamaProvider(),
      runtimes: {
        pi: emptyPiRuntime([{ id: 'glm-4.7-flash', name: 'glm-4.7-flash' }]),
        'claude-code': emptyClaudeRuntime(),
        codex: emptyCodexRuntime(),
      },
    };
    vi.mocked(getCustomProvider).mockResolvedValue(existing);
    const wrote = await syncManagedOllamaAgentProjections(['pi', 'claude-code', 'codex'], {
      stillActive: () => false,
    });
    expect(wrote).toBe(false);
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });
});

describe('local model display names', () => {
  const hfId = 'hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M';

  it('repairs a cached ID name without changing other fields', () => {
    const existing = providerWith(hfId);
    for (const runtime of Object.values(existing.runtimes)) {
      runtime.models = [
        {
          id: hfId,
          name: hfId,
          contextWindow: 65_536,
          defaultEnabled: false,
          reasoning: true,
          supportsImageInput: false,
        },
      ] as typeof runtime.models;
    }
    const before = structuredClone(existing);
    const migrated = migrateManagedOllamaProvider(existing)!;
    for (const agent of ['pi', 'claude-code', 'codex'] as const) {
      expect(migrated.runtimes[agent]).toEqual({
        ...before.runtimes[agent],
        models: [{ ...before.runtimes[agent].models[0], name: 'Ornith 1.5 35B A3B (Q4_K_M)' }],
      });
    }
    expect(existing).toEqual(before);
    expect(migrateManagedOllamaProvider(migrated)).toBe(migrated);
  });

  it.each([{ name: 'My local model' }, { name: hfId, nameExplicit: true }, { name: '' }, {}])(
    'leaves names other than implicit ID fallbacks untouched: %j',
    (saved) => {
      const existing = providerWith(hfId);
      for (const runtime of Object.values(existing.runtimes)) {
        runtime.models = [{ id: hfId, ...saved }] as typeof runtime.models;
      }
      expect(migrateManagedOllamaProvider(existing)).toBe(existing);
    },
  );

  it('does not normalize unrelated custom providers', () => {
    const existing = { ...providerWith(hfId), id: 'my-ollama' };
    expect(migrateManagedOllamaProvider(existing)).toBeNull();
    expect(existing.runtimes.pi.models[0].name).toBe(hfId);
  });

  it('repairs legacy Pi-only names without inventing coding-agent capabilities', () => {
    const existing = providerWith(hfId);
    const migrated = migrateManagedOllamaProvider({
      ...existing,
      runtimes: { pi: existing.runtimes.pi },
    })!;
    expect(migrated.runtimes.pi?.models).toEqual([
      { id: hfId, name: 'Ornith 1.5 35B A3B (Q4_K_M)' },
    ]);
    expect(migrated.runtimes['claude-code']?.models).toEqual([]);
    expect(migrated.runtimes.codex?.models).toEqual([]);
  });

  it.each([
    ['hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M', 'Ornith 1.5 35B A3B (Q4_K_M)'],
    ['hf.co/team/Example-GGUF:Q8_0', 'Example (Q8_0)'],
    ['hf.co/team/Example-GGUF:latest', 'Example'],
    ['custom-model:8b', 'custom-model:8b'],
  ])('formats %s without changing its execution ID', (id, name) => {
    expect(toPlainRuntimeModel(id)).toMatchObject({ id, name });
  });
});
