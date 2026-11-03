import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

export function sshModel(id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    ...patch,
  };
}

export function sshProvider(
  id: string,
  models = [sshModel('available-model')],
  agent: AgentKind = 'codex',
): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    connected: true,
    agents: [agent],
    auth: { method: 'apiKey' },
    routing: { [agent]: { upstream: 'https://example.test', authStrategy: 'api-key-header' } },
    models: { [agent]: models },
  };
}

export function sshNativeCodexProvider(models = [sshModel('available-model')]): ProviderView {
  const provider = sshProvider('openai', models);
  provider.auth = { method: 'oauth' };
  provider.routing.codex = {
    upstream: 'https://chatgpt.com/backend-api/codex',
    authStrategy: 'oauth-passthrough',
  };
  return provider;
}
