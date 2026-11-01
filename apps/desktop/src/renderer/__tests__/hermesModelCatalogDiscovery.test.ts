import { describe, expect, it } from 'vitest';

import {
  buildDiscoveredEndpointDescriptors,
  buildHermesDescriptors,
} from '@/hooks/useHermesModelCatalog';
import type { ProviderFileEndpointView } from '@cindy/model-providers';

describe('useHermesModelCatalog discovery helpers (ROADMAP 2.2b)', () => {
  it('projects online endpoints into picker ModelDescriptor rows with endpoint context length and deduplicates against existing models', () => {
    const base = buildHermesDescriptors(
      { model: 'deepseek-chat', provider: 'deepseek' },
      ['deepseek-chat', 'deepseek-reasoner'],
    );
    const existingIds = new Set(base.map((d) => d.id));
    existingIds.add('deepseek-chat');

    const endpoints: ProviderFileEndpointView[] = [
      {
        id: 'ollama-local',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        local: true,
        capabilities: { tools: true, vision: false, contextLength: 65_536 },
        status: 'online',
        models: ['qwen2.5-coder:7b', 'deepseek-reasoner', 'llama3.2:3b'],
      },
      {
        id: 'lmstudio-local',
        kind: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        local: true,
        capabilities: { tools: false, vision: false },
        status: 'offline',
        models: [],
        error: 'ECONNREFUSED',
      },
    ];

    const result = buildDiscoveredEndpointDescriptors(endpoints, existingIds);

    expect(result.descriptors).toEqual([
      {
        id: 'qwen2.5-coder:7b',
        displayName: 'qwen2.5-coder:7b (ollama-local)',
        description: 'Local endpoint ollama-local',
        contextWindow: 65_536,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'llama3.2:3b',
        displayName: 'llama3.2:3b (ollama-local)',
        description: 'Local endpoint ollama-local',
        contextWindow: 65_536,
        efforts: [],
        defaultEffort: null,
      },
    ]);

    expect(result.endpointStatuses).toEqual([
      {
        id: 'ollama-local',
        status: 'online',
        local: true,
        modelCount: 3,
      },
      {
        id: 'lmstudio-local',
        status: 'offline',
        local: true,
        modelCount: 0,
        error: 'ECONNREFUSED',
      },
    ]);
  });

  it('never leaks models from offline or error endpoints even if probe view carries model strings', () => {
    const endpoints: ProviderFileEndpointView[] = [
      {
        id: 'lmstudio-local',
        kind: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        local: true,
        capabilities: { tools: true, vision: false },
        status: 'offline',
        models: ['stale-model-should-not-appear'],
        error: 'connection refused',
      },
    ];

    const result = buildDiscoveredEndpointDescriptors(endpoints);
    expect(result.descriptors).toEqual([]);
    expect(result.endpointStatuses).toEqual([
      {
        id: 'lmstudio-local',
        status: 'offline',
        local: true,
        modelCount: 0,
        error: 'connection refused',
      },
    ]);
  });
});
