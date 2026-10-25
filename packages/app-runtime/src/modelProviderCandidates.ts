import type { AgentKind, Catalog } from '@cindy/model-providers';

/** The original implicit-route candidates; ambiguity never chooses a default. */
export function modelProviderCandidates(
  catalog: Pick<Catalog, 'providers'>,
  modelId: string,
  agent: AgentKind,
  available: (providerId: string) => boolean,
) {
  return catalog.providers.filter(provider =>
    available(provider.id) && provider.agents.includes(agent) &&
    Boolean(provider.routing[agent] && !provider.routing[agent]?.disabled) &&
    (provider.models[agent] ?? []).some(model => model.id === modelId),
  );
}
