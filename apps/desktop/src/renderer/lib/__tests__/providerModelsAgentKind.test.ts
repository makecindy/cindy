import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import {
  resolveProviderModelContextWindow,
  resolveVisibleModelAgentKind,
} from '../providerModels';

const model = (id: string): ModelDescriptor => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  efforts: ['high'],
  defaultEffort: 'high',
});

const provider = (
  agent: AgentKind,
  models: ModelDescriptor[],
  id: string = agent,
): ProviderView =>
  ({
    id,
    name: id,
    connected: true,
    agents: [agent],
    routing: { [agent]: {} },
    models: {
      [agent]: models.map((entry) => ({ ...entry, name: entry.displayName })),
    },
  }) as unknown as ProviderView;

describe('provider model routing helpers', () => {
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

  it('resolves duplicate model ids by provider route instead of first-wins order', () => {
    const wide = { ...model('shared-model'), contextWindow: 1_000_000 };
    const narrow = { ...model('shared-model'), contextWindow: 200_000 };
    const providers = [
      provider('claude-code', [wide], 'wide-source'),
      provider('claude-code', [narrow], 'narrow-source'),
    ];

    expect(
      resolveProviderModelContextWindow({
        providers,
        providerId: 'wide-source',
        modelId: 'shared-model',
        agentKind: 'claude-code',
      }),
    ).toBe(1_000_000);
    expect(
      resolveProviderModelContextWindow({
        providers,
        providerId: 'narrow-source',
        modelId: 'shared-model',
        agentKind: 'claude-code',
      }),
    ).toBe(200_000);
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
