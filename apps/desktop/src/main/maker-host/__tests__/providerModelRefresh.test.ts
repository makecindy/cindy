import { describe, expect, it, vi } from 'vitest';

import {
  refreshBuiltinProviderModels,
  type BuiltinProviderModelRefreshDeps,
} from '../provider-model-refresh.js';

function deps(
  overrides: Partial<BuiltinProviderModelRefreshDeps> = {},
): BuiltinProviderModelRefreshDeps {
  return {
    refreshXd: vi.fn(async () => {}),
    refreshAnthropic: vi.fn(async () => true),
    refreshOpenAi: vi.fn(async () => true),
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
    if (providerId === 'xai') expect(d.refreshXaiMedia).toHaveBeenCalledOnce();
  });

  it('rejects stale or unapplied dynamic snapshots', async () => {
    await expect(
      refreshBuiltinProviderModels('anthropic', deps({ refreshAnthropic: async () => false })),
    ).rejects.toThrow(/Anthropic model discovery/);
    await expect(
      refreshBuiltinProviderModels('openai', deps({ refreshOpenAi: async () => false })),
    ).rejects.toThrow(/OpenAI model discovery/);
    await expect(
      refreshBuiltinProviderModels('xai', deps({ refreshXai: async () => false })),
    ).rejects.toThrow(/xAI account model discovery/);
    await expect(
      refreshBuiltinProviderModels('xai', deps({ refreshXaiMedia: async () => false })),
    ).rejects.toThrow(/xAI media model discovery/);
  });
});
