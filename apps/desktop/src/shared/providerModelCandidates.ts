import {
  availableModelInterfaces,
  isOpenRouterModelsUrl,
  providerModelsForRoute,
  providerWireProtocolForApi,
  type AgentKind,
  type ModelRegistry,
  type ProviderModelRouteConfig,
  type ProviderPreset,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

const cleanUrl = (url: string) => url.replace(/\/+$/, '');

function sameRoute(left: ProviderModelRouteConfig, right: ProviderModelRouteConfig): boolean {
  return cleanUrl(left.baseUrl) === cleanUrl(right.baseUrl)
    && left.wireProtocol === right.wireProtocol
    && (left.requestPath ?? '') === (right.requestPath ?? '');
}

export function presetCandidateRoute(preset: ProviderPreset, agent: AgentKind, baseUrl?: string): ProviderModelRouteConfig {
  const runtime = preset.runtimes[agent]!;
  return {
    baseUrl: baseUrl ?? runtime.baseUrl,
    wireProtocol: runtime.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'pi' ? 'openai-chat' : 'openai-responses'),
    ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
  };
}

export function presetModelCandidate(
  preset: ProviderPreset,
  agent: AgentKind,
  model: Pick<ProviderRuntimeModelConfig, 'id' | 'name'>,
  registry: ModelRegistry | undefined,
  runtimeRoute: ProviderModelRouteConfig,
  sourceRoute = runtimeRoute,
  requireDeclaration = false,
): ProviderRuntimeModelConfig | undefined {
  if (preset.runtimes[agent]?.models.some(candidate => candidate.id === model.id)) return model;
  const entries = registry?.models.filter(entry => entry.routes.some(route => route.providerId === preset.id && route.modelId === model.id)) ?? [];
  if (entries.some(entry => entry.status === 'retired' || entry.routes.some(route => route.providerId === preset.id && route.modelId === model.id && route.interfaces?.length === 0))) return undefined;
  const hasBindings = entries.some(entry => entry.routes.some(route => route.providerId === preset.id && route.modelId === model.id && route.interfaces !== undefined));
  const choices = availableModelInterfaces(registry, preset.id, model.id, runtimeRoute.baseUrl, agent);
  const explicitRoute = sourceRoute.requestPath ? sourceRoute : runtimeRoute.requestPath ? runtimeRoute : undefined;
  if (explicitRoute) {
    if ((requireDeclaration || hasBindings) && !choices.some(choice => choice.route.wireProtocol === explicitRoute.wireProtocol)) return undefined;
    return sameRoute(runtimeRoute, sourceRoute) ? model : { ...model, route: sourceRoute };
  }
  const selected = choices.find(choice => choice.preferred)
    ?? choices.find(choice => sameRoute(choice.route, runtimeRoute))
    ?? choices.find(choice => sameRoute(choice.route, sourceRoute))
    ?? choices[0];
  if (selected) {
    return choices.find(choice => choice.preferred)?.profileId === selected.profileId
      ? model
      : { ...model, interfaceId: selected.profileId, route: selected.route };
  }
  const hasProfiles = registry?.interfaceProfiles?.some(profile => profile.providerId === preset.id
    && [...profile.inputBaseUrls, profile.baseUrl].some(url => cleanUrl(url) === cleanUrl(runtimeRoute.baseUrl)));
  if (hasProfiles || hasBindings) return undefined;
  if (requireDeclaration && !(isOpenRouterModelsUrl(preset.runtimes[agent]?.modelsUrl ?? '')
    && /^https:\/\/openrouter\.ai\/api(?:\/v1)?\/?$/.test(runtimeRoute.baseUrl))) return undefined;
  return sameRoute(runtimeRoute, sourceRoute) ? model : { ...model, route: sourceRoute };
}

export function presetSupplementalModels(
  preset: ProviderPreset,
  agent: AgentKind,
  registry: ModelRegistry | undefined,
  baseUrl?: string,
): ProviderRuntimeModelConfig[] {
  const runtimeRoute = presetCandidateRoute(preset, agent, baseUrl);
  if (runtimeRoute.requestPath) return [];
  const routes: ProviderModelRouteConfig[] = [runtimeRoute];
  for (const profile of registry?.interfaceProfiles ?? []) {
    const wireProtocol = providerWireProtocolForApi(profile.api);
    if (profile.providerId !== preset.id || profile.retired || !wireProtocol
      || ![...profile.inputBaseUrls, profile.baseUrl].some(url => cleanUrl(url) === cleanUrl(runtimeRoute.baseUrl))) continue;
    routes.push({ baseUrl: profile.baseUrl, wireProtocol,
      ...(profile.requestPath ? { requestPath: profile.requestPath } : {}) });
  }
  const candidates = new Map<string, ProviderRuntimeModelConfig>();
  for (const sourceRoute of routes) {
    for (const model of providerModelsForRoute(sourceRoute.baseUrl, agent === 'pi' && !registry ? undefined : sourceRoute.wireProtocol)) {
      if (candidates.has(model.id)) continue;
      const candidate = presetModelCandidate(preset, agent, model, registry, runtimeRoute, sourceRoute);
      if (candidate) candidates.set(model.id, candidate);
    }
  }
  return [...candidates.values()];
}
