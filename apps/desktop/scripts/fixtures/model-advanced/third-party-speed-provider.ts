import { buildUserProvider, mergeDiscoveredRuntimeModels, parseModelsListResponse } from '@cindy/model-providers';

export function thirdPartySpeedProvider() {
  const discovered = parseModelsListResponse({ data: [{ id: 'sub2api/gpt-6.2-sol',
    service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }],
  }] })!;
  return {
    ...buildUserProvider({ id: 'fixture-relay', name: 'Example provider', runtimes: { codex: {
      baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses',
      models: mergeDiscoveredRuntimeModels([], discovered),
    } } }),
    connected: true,
  };
}
