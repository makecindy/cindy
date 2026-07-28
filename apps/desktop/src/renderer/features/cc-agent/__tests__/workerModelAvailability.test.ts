import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { selectWorkerModels } from '../workerModelAvailability';

const model = (id: string): ModelDescriptor => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  efforts: ['high'],
  defaultEffort: 'high',
});

const capabilities = (models: ModelDescriptor[]): AgentCapabilities =>
  ({ availableModels: models }) as AgentCapabilities;

const provider = (
  id: string,
  connected: boolean,
  agent: 'claude-code' | 'codex',
  models: ModelDescriptor[],
): ProviderView =>
  ({
    id,
    name: id,
    connected,
    agents: [agent],
    routing: { [agent]: {} },
    models: {
      [agent]: models.map((entry) => ({ ...entry, name: entry.displayName })),
    },
  }) as unknown as ProviderView;

describe('selectWorkerModels', () => {
  const standard = model('gpt-5.5');
  const budget = model('codex/gpt-5.5');
  const caps = capabilities([standard, budget]);

  it('only offers local Codex models backed by a connected provider', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('openai', true, 'codex', [standard])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['gpt-5.5']);

    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('xd', true, 'codex', [budget])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['codex/gpt-5.5']);

    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('custom', true, 'codex', [])],
        providersLoading: false,
        providersError: null,
      }),
    ).toEqual([]);
  });

  it('only offers local Claude models backed by a connected provider', () => {
    const opus = model('claude-opus-4-8');
    const sonnet = model('claude-sonnet-4-6');

    expect(
      selectWorkerModels({
        agent: 'claude-code',
        capabilities: capabilities([opus, sonnet]),
        providers: [provider('anthropic', true, 'claude-code', [sonnet])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['claude-sonnet-4-6']);
  });

  it('excludes ignored local models while retaining a model enabled by another provider', () => {
    const hidden = model('hidden-model');
    const shared = model('shared-model');

    expect(
      selectWorkerModels({
        agent: 'claude-code',
        capabilities: capabilities([hidden, shared]),
        providers: [
          provider('provider-a', true, 'claude-code', [hidden, shared]),
          provider('provider-b', true, 'claude-code', [shared]),
        ],
        providersLoading: false,
        providersError: null,
        isVisible: (providerId, entry) =>
          entry.id === 'shared-model' && providerId === 'provider-b',
      }).map((entry) => entry.id),
    ).toEqual(['shared-model']);
  });

  it('uses each controlled device provider snapshot without leaking models across devices', () => {
    const deviceA = selectWorkerModels({
      agent: 'codex',
      capabilities: caps,
      deviceId: 'device-a',
      providers: [provider('openai', true, 'codex', [standard])],
      providersLoading: false,
      providersError: null,
    });
    const deviceB = selectWorkerModels({
      agent: 'codex',
      capabilities: caps,
      deviceId: 'device-b',
      providers: [provider('xd', true, 'codex', [budget])],
      providersLoading: false,
      providersError: null,
    });

    expect(deviceA.map((entry) => entry.id)).toEqual(['gpt-5.5']);
    expect(deviceB.map((entry) => entry.id)).toEqual(['codex/gpt-5.5']);
  });

  it('falls back to controlled-device capabilities for old peers without provider:list', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        deviceId: 'old-device',
        providers: [],
        providersLoading: false,
        providersError: 'unknown channel',
      }),
    ).toEqual([standard, budget]);
  });

  it('does not submit a stale selection while a new device provider snapshot is loading', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        deviceId: 'device-b',
        providers: [],
        providersLoading: true,
        providersError: null,
      }),
    ).toEqual([]);
  });
});
