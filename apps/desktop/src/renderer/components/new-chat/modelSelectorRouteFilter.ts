import type { AgentKind, ProviderView } from '@cindy/model-providers';

/** Exact catalog identity; null identifies the local computer. */
export type ModelSelectorRouteFilter = (route: {
  deviceId: string | null;
  providerId: string;
  agentKind: AgentKind;
  model: string;
}) => boolean;

/** Filter the catalog itself so rail, groups, favorites and selection share the same boundary. */
export function filterModelSelectorRoutes(
  providers: ProviderView[], deviceId: string | null, filter?: ModelSelectorRouteFilter,
): ProviderView[] {
  if (!filter) return providers;
  return providers.flatMap((provider) => {
    const models = { ...provider.models };
    const agents = provider.agents.filter((agent) => {
      models[agent] = (provider.models[agent] ?? []).filter((model) =>
        filter({ deviceId, providerId: provider.id, agentKind: agent, model: model.id }));
      return models[agent]!.length > 0;
    });
    return agents.length ? [{ ...provider, agents, models }] : [];
  });
}
