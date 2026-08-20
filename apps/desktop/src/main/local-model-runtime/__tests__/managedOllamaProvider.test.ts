import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../maker-host/custom-provider-store.js', () => ({
  createCustomProvider: vi.fn(),
  getCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

import { getCustomProvider, updateCustomProvider } from '../../maker-host/custom-provider-store.js';
import {
  buildEmptyManagedOllamaProvider,
  emptyClaudeRuntime,
  emptyCodexRuntime,
  emptyPiRuntime,
  upsertManagedOllamaModel,
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
});
