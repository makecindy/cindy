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
const sameRoute = (a: ProviderModelRouteConfig, b: ProviderModelRouteConfig) =>
  cleanUrl(a.baseUrl) === cleanUrl(b.baseUrl) && a.wireProtocol === b.wireProtocol
    && (a.requestPath ?? '') === (b.requestPath ?? '');

export function presetCandidateRoute(preset: ProviderPreset, agent: AgentKind, baseUrl?: string): ProviderModelRouteConfig {
  const runtime = preset.runtimes[agent]!;
  return { baseUrl: baseUrl ?? runtime.baseUrl,
    wireProtocol: runtime.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'pi' ? 'openai-chat' : 'openai-responses'),
    ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
  };
}

/** Coverage belongs to this endpoint and wire language, including withdrawn
 * profiles. A partially migrated product must retain its other legacy runtimes. */
export function presetRouteHasInterfaceProfiles(
  preset: ProviderPreset, registry: ModelRegistry | undefined, route: ProviderModelRouteConfig,
): boolean {
  return registry?.schemaVersion === 6 && (registry.interfaceProfiles ?? []).some(profile =>
    profile.providerId === preset.id && providerWireProtocolForApi(profile.api) === route.wireProtocol
    && [...profile.inputBaseUrls, profile.baseUrl].some(url => cleanUrl(url) === cleanUrl(route.baseUrl)));
}

/** Combine inventory evidence with the existing interface resolver. A shared
 * inventory alone does not declare a second protocol; explicit denials must not
 * become an invitation to fall back to the older offline inventory. */
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
  const matches = registry?.schemaVersion === 6 ? registry.models.flatMap(entry => entry.routes
    .filter(route => route.providerId === preset.id && route.modelId === model.id)
    .map(route => ({ entry, route }))) : [];
  if (matches.length > 1 || matches.some(({ entry, route }) => entry.status === 'retired' || route.interfaces?.length === 0)) return;
  // A compatible interface cannot grant CC/Codex membership denied by an exact
  // Registry route. Pi's membership is maintained separately in its inventory.
  if (agent !== 'pi' && matches.some(({ route }) => !route.agents.includes(agent))) return;
  const hasBinding = matches.some(({ route }) => route.interfaces !== undefined);
  const profiles = registry?.schemaVersion === 6 ? (registry.interfaceProfiles ?? []).filter(profile =>
    profile.providerId === preset.id && (!profile.modelIds || profile.modelIds.includes(model.id))
    && [...profile.inputBaseUrls, profile.baseUrl].some(url => cleanUrl(url) === cleanUrl(runtimeRoute.baseUrl))) : [];
  const choices = availableModelInterfaces(registry, preset.id, model.id, runtimeRoute.baseUrl, agent);
  const sourceCovered = profiles.some(profile => providerWireProtocolForApi(profile.api) === sourceRoute.wireProtocol);
  const sourceAvailable = choices.some(choice => choice.route.wireProtocol === sourceRoute.wireProtocol);
  const explicitRoute = sourceRoute.requestPath ? sourceRoute : runtimeRoute.requestPath ? runtimeRoute : undefined;
  if (explicitRoute) {
    if ((requireDeclaration || hasBinding || sourceCovered) && !choices.some(choice => choice.route.wireProtocol === explicitRoute.wireProtocol)) return;
    return sameRoute(runtimeRoute, sourceRoute) ? model : { ...model, route: sourceRoute };
  }
  const selected = choices.find(choice => choice.preferred) ?? (hasBinding ? choices[0] : undefined);
  if (selected) {
    // Auto is an existing reference, not a saved API/URL override. Non-default
    // interfaces need an explicit reference so Chat-only models remain runnable.
    return { ...model, interfaceId: selected.preferred ? 'auto' : selected.profileId };
  }
  if (hasBinding || (sourceCovered && !sourceAvailable)) return;
  if (requireDeclaration && !sourceAvailable && !(isOpenRouterModelsUrl(preset.runtimes[agent]?.modelsUrl ?? '')
    && /^https:\/\/openrouter\.ai\/api(?:\/v1)?\/?$/.test(runtimeRoute.baseUrl))) return;
  return sameRoute(runtimeRoute, sourceRoute) ? model : { ...model, route: sourceRoute };
}

/** Offline suggestions stay scoped to an exact endpoint. Enumerating a product's
 * accepted profiles finds inventory rows on its other APIs without copying a
 * sibling engine's membership or changing the maintained recommendations. */
export function presetSupplementalModels(
  preset: ProviderPreset, agent: AgentKind, registry: ModelRegistry | undefined, baseUrl?: string,
): ProviderRuntimeModelConfig[] {
  const route = presetCandidateRoute(preset, agent, baseUrl);
  if (route.requestPath) return [];
  const sources = [route];
  if (registry?.schemaVersion === 6) for (const profile of registry.interfaceProfiles ?? []) {
    const protocol = providerWireProtocolForApi(profile.api);
    if (profile.providerId !== preset.id || profile.retired || !protocol
      || ![...profile.inputBaseUrls, profile.baseUrl].some(url => cleanUrl(url) === cleanUrl(route.baseUrl))) continue;
    sources.push({ baseUrl: profile.baseUrl, wireProtocol: protocol,
      ...(profile.requestPath ? { requestPath: profile.requestPath } : {}) });
  }
  const candidates = new Map<string, ProviderRuntimeModelConfig>();
  // A global V6 registry may still leave this product on its legacy Pi adapter.
  // Declared (including retired) profiles keep the stricter interface resolver.
  const hasInterfaceProfiles = presetRouteHasInterfaceProfiles(preset, registry, route);
  for (const source of sources) {
    const protocol = agent === 'pi' && !hasInterfaceProfiles ? undefined : source.wireProtocol;
    for (const model of providerModelsForRoute(source.baseUrl, protocol)) {
      if (candidates.has(model.id)) continue;
      const candidate = presetModelCandidate(preset, agent, model, registry, route, source);
      if (candidate) candidates.set(model.id, candidate);
    }
  }
  return [...candidates.values()];
}
