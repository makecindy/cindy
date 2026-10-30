import { describe, expect, it, vi } from 'vitest';

import {
  refreshBuiltinProviderModels,
  refreshModelsWithCatalog,
  type BuiltinProviderModelRefreshDeps,
} from '../provider-model-refresh.js';

function deps(
  overrides: Partial<BuiltinProviderModelRefreshDeps> = {},
): BuiltinProviderModelRefreshDeps {
  return {
    refreshXd: vi.fn(async () => {}),
    refreshAnthropic: vi.fn(async () => true),
    refreshOpenAi: vi.fn(async () => true),
    refreshOpenAiMedia: vi.fn(async () => true),
    refreshXai: vi.fn(async () => true),
    refreshXaiMedia: vi.fn(async () => true),
    ...overrides,
  };
}

describe('refreshBuiltinProviderModels', () => {
  it.each([
    ['xd', 'refreshXd'],
    ['anthropic', 'refreshAnthropic'],
    ['openai', 'refreshOpenAi'],
    ['xai', 'refreshXai'],
  ] as const)('dispatches %s to its existing refresh source', async (providerId, method) => {
    const d = deps();
    await refreshBuiltinProviderModels(providerId, d);
    expect(d[method]).toHaveBeenCalledOnce();
    if (providerId === 'openai') expect(d.refreshOpenAiMedia).toHaveBeenCalledOnce();
    if (providerId === 'xai') expect(d.refreshXaiMedia).toHaveBeenCalledOnce();
  });

  it('rejects stale or unapplied dynamic snapshots', async () => {
    await expect(
      refreshBuiltinProviderModels('anthropic', deps({ refreshAnthropic: async () => false })),
    ).rejects.toThrow(/Anthropic model discovery/);
    const openaiChatMissMediaHit = deps({
      refreshOpenAi: vi.fn(async () => false),
      refreshOpenAiMedia: vi.fn(async () => true),
    });
    await expect(
      refreshBuiltinProviderModels('openai', openaiChatMissMediaHit),
    ).resolves.toBeUndefined();
    expect(openaiChatMissMediaHit.refreshOpenAiMedia).toHaveBeenCalledOnce();
    const openaiBothMiss = deps({
      refreshOpenAi: vi.fn(async () => false),
      refreshOpenAiMedia: vi.fn(async () => false),
    });
    await expect(
      refreshBuiltinProviderModels('openai', openaiBothMiss),
    ).rejects.toThrow(/OpenAI model discovery/);
    const openaiChatThrowMediaHit = deps({
      refreshOpenAi: vi.fn(async () => {
        throw new Error('Codex control plane failed to start');
      }),
      refreshOpenAiMedia: vi.fn(async () => true),
    });
    await expect(
      refreshBuiltinProviderModels('openai', openaiChatThrowMediaHit),
    ).resolves.toBeUndefined();
    expect(openaiChatThrowMediaHit.refreshOpenAiMedia).toHaveBeenCalledOnce();
    const openaiChatThrowMediaMiss = deps({
      refreshOpenAi: vi.fn(async () => {
        throw new Error('Codex control plane failed to start');
      }),
      refreshOpenAiMedia: vi.fn(async () => false),
    });
    await expect(
      refreshBuiltinProviderModels('openai', openaiChatThrowMediaMiss),
    ).rejects.toThrow(/Codex control plane failed to start/);
    expect(openaiChatThrowMediaMiss.refreshOpenAiMedia).toHaveBeenCalledOnce();
    const openaiMediaMiss = deps({ refreshOpenAiMedia: async () => false });
    await expect(refreshBuiltinProviderModels('openai', openaiMediaMiss)).resolves.toBeUndefined();
    expect(openaiMediaMiss.refreshOpenAi).toHaveBeenCalledOnce();
    await expect(
      refreshBuiltinProviderModels('xai', deps({ refreshXai: async () => false })),
    ).rejects.toThrow(/xAI account model discovery/);
    await expect(
      refreshBuiltinProviderModels('xai', deps({ refreshXaiMedia: async () => false })),
    ).rejects.toThrow(/xAI media model discovery/);
  });
});

describe('refreshModelsWithCatalog', () => {
  it('updates the catalog before the selected account discovery and preserves its result', async () => {
    const steps: string[] = [];
    const result = await refreshModelsWithCatalog({
      refreshCatalog: async () => { steps.push('catalog'); },
      refreshModels: async () => { steps.push('selected-account'); return false; },
      getScopeKey: () => 1,
    });
    expect(steps).toEqual(['catalog', 'selected-account']);
    expect(result).toBe(false);
  });

  it('does not discover accounts after a failed catalog refresh', async () => {
    const refreshModels = vi.fn(async () => true);
    await expect(refreshModelsWithCatalog({
      refreshCatalog: async () => { throw new Error('offline'); },
      refreshModels,
      getScopeKey: () => 1,
    })).rejects.toThrow('offline');
    expect(refreshModels).not.toHaveBeenCalled();
  });

  it.each(['catalog', 'discovery'] as const)('rejects an owner switch during %s', async (stage) => {
    let scope = 1;
    const refreshModels = vi.fn(async () => { scope++; return true; });
    await expect(refreshModelsWithCatalog({
      refreshCatalog: async () => { if (stage === 'catalog') scope++; },
      refreshModels,
      getScopeKey: () => scope,
    })).rejects.toThrow('Account changed');
    expect(refreshModels).toHaveBeenCalledTimes(stage === 'catalog' ? 0 : 1);
  });

  it('preserves a discovery failure after the public catalog succeeds', async () => {
    await expect(refreshModelsWithCatalog({
      refreshCatalog: async () => undefined,
      refreshModels: async () => { throw new Error('discovery failed'); },
      getScopeKey: () => 1,
    })).rejects.toThrow('discovery failed');
  });
});
