import { describe, expect, it } from 'vitest';

import {
  parseProvidersFile,
  projectProviderFileEndpoints,
  providerFileEntryToCatalogModels,
  type ProviderFileEntry,
} from '../index.js';

describe('providersFile projection (ROADMAP 2.1b)', () => {
  const localEntry: ProviderFileEntry = {
    id: 'lmstudio-local',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    capabilities: {
      tools: true,
      vision: false,
      contextLength: 32_768,
    },
    local: true,
  };

  const remoteEntry: ProviderFileEntry = {
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    capabilities: {
      tools: true,
      vision: true,
    },
    local: false,
  };

  it('projects ProviderFileEntry models into CatalogModel with declared capabilities and context length', () => {
    const localModels = providerFileEntryToCatalogModels(localEntry, [
      'qwen3-8b',
      'qwen3-8b',
      '  ',
    ]);
    expect(localModels).toEqual([
      {
        id: 'qwen3-8b',
        name: 'qwen3-8b',
        contextWindow: 32_768,
        contextWindowVerified: true,
        contextWindowExplicit: true,
        efforts: [],
        defaultEffort: null,
        supportsToolCalls: true,
        supportsImageInput: false,
        modalities: {
          input: ['text'],
          output: ['text'],
        },
        capabilities: {
          toolCall: true,
          attachment: false,
        },
      },
    ]);

    const remoteModels = providerFileEntryToCatalogModels(remoteEntry, ['deepseek-flash']);
    expect(remoteModels[0]?.contextWindow).toBe(200_000);
    expect(remoteModels[0]?.contextWindowVerified).toBe(false);
    expect(remoteModels[0]?.supportsImageInput).toBe(true);
    expect(remoteModels[0]?.modalities?.input).toEqual(['text', 'image']);
  });

  it('merges providers.yaml entries with discovery probes and strips stale models from offline/error probes', () => {
    const parsed = parseProvidersFile({
      providers: [
        {
          id: 'lmstudio-local',
          kind: 'lmstudio',
          baseUrl: 'http://127.0.0.1:1234/v1',
          capabilities: { tools: true, vision: false, contextLength: 32_768 },
        },
        {
          id: 'ollama-local',
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          capabilities: { tools: false, vision: false },
        },
        {
          id: 'deepseek',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          keyEnv: 'DEEPSEEK_API_KEY',
        },
      ],
    });
    expect(parsed.issues).toEqual([]);

    const projected = projectProviderFileEndpoints(parsed.providers, [
      {
        id: 'lmstudio-local',
        status: 'online',
        models: ['qwen3-8b', 'nomic-embed'],
        latencyMs: 12,
      },
      {
        id: 'ollama-local',
        status: 'offline',
        models: ['stale-model-that-must-not-appear'],
        latencyMs: 2000,
        error: 'connect ECONNREFUSED',
      },
    ]);

    expect(projected).toEqual([
      {
        ...parsed.providers[0],
        status: 'online',
        models: ['qwen3-8b', 'nomic-embed'],
        latencyMs: 12,
      },
      {
        ...parsed.providers[1],
        status: 'offline',
        models: [],
        latencyMs: 2000,
        error: 'connect ECONNREFUSED',
      },
      {
        ...parsed.providers[2],
        status: 'unprobed',
        models: [],
      },
    ]);
  });
});
