import type { Catalog, AgentKind } from './index.js';
export function resolvePiGatewayDescriptorProviderId(
  providerId: string | null | undefined,
): string {
  void providerId;
  return 'xd';
}


export function resolveModelContextProviderId(
  catalog: Pick<Catalog, 'providers'>, agent: AgentKind, providerId: string | null | undefined, modelId: string,
  implicitDefaultProviderId?: string | null,
): string | null {
  if (agent === 'pi' && (providerId == null || providerId === 'cindy')) {
    return resolvePiGatewayDescriptorProviderId(providerId);
  }
  if (providerId) return providerId;
  const candidates = catalog.providers.filter((provider) => provider.routing[agent]?.disabled !== true &&
    provider.models[agent]?.some((model) => model.id === modelId));
  if (candidates.length === 1) return candidates[0]!.id;
  return implicitDefaultProviderId && candidates.some((provider) => provider.id === implicitDefaultProviderId)
    ? implicitDefaultProviderId : null;
}


export function resolveModelDefaultContextWindow(
  catalog: Catalog,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): number | null {
  const source = providerId?.trim();
  if (!source) return null;
  const provider = catalog.providers.find((entry) => entry.id === source);
  if (!provider) return null;
  if (provider.routing[agent]?.disabled === true) return null;
  const model = (provider.models[agent] ?? []).find((entry) => entry.id === modelId);
  return model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow : null;
}

