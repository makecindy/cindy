import { describe, expect, it, vi } from 'vitest';

import { buildOrcaModelRoutes } from '../orcaModelRoutes';
import type { OrcaWorkerProviderRoutingContext } from '../orcaWorkerCreationService';

describe('buildOrcaModelRoutes', () => {
  it('keeps duplicate model ids as distinct provider routes and marks the default', () => {
    const resolveDefaultProviderIdForModel = vi.fn(() => 'openai');
    const routing: OrcaWorkerProviderRoutingContext = {
      availability: {
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'Cindy AI', models: ['gpt-5.5'] },
          { id: 'openai', name: 'OpenAI', models: ['gpt-5.5', 'gpt-5.6-sol'] },
        ],
        pi: [],
      },
      resolveDefaultProviderIdForModel,
    };

    expect(buildOrcaModelRoutes({
      agent: 'codex',
      models: [
        { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
      ],
      routing,
    })).toEqual([
      {
        modelId: 'gpt-5.5',
        label: 'GPT-5.5',
        providerId: 'xd',
        providerName: 'Cindy AI',
        isDefault: false,
      },
      {
        modelId: 'gpt-5.5',
        label: 'GPT-5.5',
        providerId: 'openai',
        providerName: 'OpenAI',
        isDefault: true,
      },
      {
        modelId: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        providerId: 'openai',
        providerName: 'OpenAI',
        isDefault: true,
      },
    ]);
    expect(resolveDefaultProviderIdForModel).toHaveBeenCalledTimes(2);
  });

  it('uses the model id when the flattened catalog has no label', () => {
    const routing: OrcaWorkerProviderRoutingContext = {
      availability: {
        'claude-code': [],
        codex: [{ id: 'custom', name: 'Custom', models: ['custom-model'] }],
        pi: [],
      },
      resolveDefaultProviderIdForModel: () => 'custom',
    };

    expect(buildOrcaModelRoutes({ agent: 'codex', models: [], routing })).toEqual([
      {
        modelId: 'custom-model',
        label: 'custom-model',
        providerId: 'custom',
        providerName: 'Custom',
        isDefault: true,
      },
    ]);
  });
});
