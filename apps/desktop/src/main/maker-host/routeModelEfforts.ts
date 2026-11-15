import type { AgentKind, Catalog, Effort } from '@cindy/model-providers';

/** Resolves the provider whose catalog entry describes a model (context, efforts). */
export type ModelContextProviderResolver = (
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
) => string | null;

/**
 * Efforts declared by the route this session actually uses. Same-ID models from different
 * providers can declare different efforts; null means the route is unknown or ambiguous.
 * Type-only imports keep this a leaf module, so importing it never reorders startup.
 */
export function resolveRouteModelEfforts(
  resolveContextProviderId: ModelContextProviderResolver,
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): readonly Effort[] | null {
  const source = resolveContextProviderId(catalog, agent, providerId, modelId);
  if (!source) return null;
  return catalog.providers.find((provider) => provider.id === source)
    ?.models[agent]?.find((model) => model.id === modelId)?.efforts ?? null;
}
