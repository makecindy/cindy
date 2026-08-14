import { buildUserProvider, type AgentKind, type ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import {
  resolveFlatModelProviderId,
  resolveVisibleModelAgentKind,
} from '../providerModels';

const model = (id: string): ModelDescriptor => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  efforts: ['high'],
  defaultEffort: 'high',
});

const provider = (agent: AgentKind, models: ModelDescriptor[]): ProviderView =>
  ({
    id: agent,
    name: agent,
    connected: true,
    agents: [agent],
    models: {
      [agent]: models.map((entry) => ({ ...entry, name: entry.displayName })),
    },
  }) as unknown as ProviderView;

describe('resolveVisibleModelAgentKind', () => {
  const claude = model('claude-opus-4-7');
  const codex = model('gpt-5.5');

  it('classifies every merged row independently instead of reusing the selected agent', () => {
    const providers = [provider('claude-code', [claude]), provider('codex', [codex])];

    expect(
      resolveVisibleModelAgentKind({
        modelId: claude.id,
        agentKind: null,
        ccModels: [claude],
        codexModels: [codex],
        providers,
      }),
    ).toBe('claude-code');
    expect(
      resolveVisibleModelAgentKind({
        modelId: codex.id,
        agentKind: null,
        ccModels: [claude],
        codexModels: [codex],
        providers,
      }),
    ).toBe('codex');
  });

  it('uses the same Claude-first rule as the merged visible-model list for duplicate ids', () => {
    const shared = model('shared-model');

    expect(
      resolveVisibleModelAgentKind({
        modelId: shared.id,
        agentKind: null,
        ccModels: [shared],
        codexModels: [shared],
        providers: [],
      }),
    ).toBe('claude-code');
  });

  it('honors an explicitly filtered agent', () => {
    expect(
      resolveVisibleModelAgentKind({
        modelId: codex.id,
        agentKind: 'codex',
        ccModels: [],
        codexModels: [],
        providers: [],
      }),
    ).toBe('codex');
  });
});

describe('resolveFlatModelProviderId', () => {
  it('resolves the provider for the first selection in a merged picker', () => {
    const visionProvider = {
      ...buildUserProvider({
        id: 'vision-provider',
        name: 'Vision Provider',
        runtimes: {
          'claude-code': {
            baseUrl: 'https://vision.example/v1',
            models: [{ id: 'vision-model', name: 'Vision Model' }],
          },
        },
      }),
      connected: true,
    } as ProviderView;

    expect(resolveFlatModelProviderId({
      modelId: 'vision-model',
      currentAgentKind: null,
      currentProviderId: null,
      ccModels: [model('vision-model')],
      codexModels: [],
      piModels: [],
      providers: [visionProvider],
    })).toBe('vision-provider');
  });
});
