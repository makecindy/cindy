import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { resolveSessionModelCatalogMetadata, resolveVisibleModelAgentKind } from '../providerModels';

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


describe('resolveSessionModelCatalogMetadata', () => {
  it('returns exact-route access/group metadata and leaves missing snapshots to legacy callers', () => {
    const routed = provider('codex', [model('codex/opaque')]);
    routed.id = 'xd';
    routed.agents = ['codex'];
    routed.routing = {
      codex: { upstream: 'https://example.test', authStrategy: 'gateway-key' },
    };
    routed.access = { kind: 'managed' };
    routed.models.codex![0] = {
      ...routed.models.codex![0],
      group: 'gpt-budget',
    };

    expect(resolveSessionModelCatalogMetadata({
      providers: [routed],
      providerId: 'xd',
      modelId: 'codex/opaque',
      agentKind: 'codex',
    })).toEqual({ sourceAccess: { kind: 'managed' }, group: 'gpt-budget' });
    expect(resolveSessionModelCatalogMetadata({
      providers: [],
      providerId: 'xd',
      modelId: 'codex/opaque',
      agentKind: 'codex',
    })).toBeUndefined();
  });

  it('does not borrow metadata from a fallback source for a stale explicit provider', () => {
    const fallback = provider('codex', [model('codex/opaque')]);
    fallback.id = 'xd';
    fallback.agents = ['codex'];
    fallback.routing = {
      codex: { upstream: 'https://example.test', authStrategy: 'gateway-key' },
    };
    fallback.access = { kind: 'managed' };
    fallback.models.codex![0] = {
      ...fallback.models.codex![0],
      group: 'gpt-budget',
      category: 'gpt-budget',
    };

    expect(resolveSessionModelCatalogMetadata({
      providers: [fallback],
      providerId: 'deleted-provider',
      modelId: 'codex/opaque',
      agentKind: 'codex',
    })).toBeUndefined();
    expect(resolveSessionModelCatalogMetadata({
      providers: [fallback],
      providerId: null,
      modelId: 'codex/opaque',
      agentKind: 'codex',
    })).toEqual({
      sourceAccess: { kind: 'managed' },
      group: 'gpt-budget',
      category: 'gpt-budget',
    });
  });
});
