import bundled from '../catalog/model-registry.json';
import { compatibilityProtocol } from '@cindy/model-compat/protocol';
import { PI_MODEL_APIS } from './types.js';
import { applyModelMetadata, mergeModelMetadata } from './modelMetadataLayers.js';
import type { ModelRegistry, ModelInterfaceProfile, ModelInterfaceBinding } from './modelAccessBean.js';
import type { AgentKind, ProviderRuntimeModelConfig, ProviderWireProtocol, ModelInterfaceSnapshot, CatalogModel } from './types.js';

const bundledRegistry = bundled as unknown as ModelRegistry;
const clean = (value: string) => value.replace(/\/+$/, '');
/** Executable behaviors are versioned code; directory data can only select these. */
export const MODEL_INTERFACE_CAPABILITIES = [
  ...PI_MODEL_APIS.map(api => `api:${api}`), 'kimi-tool-ids-v1', 'chat-image-v1',
] as const;
/** SDK adapter names and public wire languages share one projection. */
export function providerWireProtocolForApi(api: string | null | undefined): ProviderWireProtocol | undefined {
  const protocol = compatibilityProtocol(api);
  return protocol === 'anthropic' ? 'anthropic-messages'
    : protocol === 'google' ? 'google-generative-ai' : protocol ?? undefined;
}

/** Only Google's documented public endpoints have this path relationship.
 * Custom proxies, account hosts and custom request paths are never rewritten. */
export function providerBaseUrlForApi(baseUrl: string, api: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.origin !== 'https://generativelanguage.googleapis.com') return baseUrl;
    const path = url.pathname.replace(/\/+$/, '');
    if (!/^\/v1(?:beta)?(?:\/openai)?$/.test(path)) return baseUrl;
    if (api === 'google-generative-ai') url.pathname = path.replace(/\/openai$/, '');
    else if (api === 'openai-completions') url.pathname = `${path.replace(/\/openai$/, '')}/openai`;
    else return baseUrl;
    return url.toString().replace(/\/$/, '');
  } catch { return baseUrl; }
}

/** The selected HTTP API and its route must agree. In particular, a model's
 * explicit Responses API cannot inherit a connection's Chat default. SDK-only
 * adapters retain their own transport, and custom request paths stay explicit. */
export function alignModelApiRoute<T extends ProviderRuntimeModelConfig>(model: T, baseUrl: string, runtimeWire?: string): T {
  const api = model.api ?? model.piApi;
  const wireProtocol = providerWireProtocolForApi(api);
  if (!api || !wireProtocol || model.route?.requestPath) return model;
  const upstream = model.route?.baseUrl ?? baseUrl;
  const target = providerBaseUrlForApi(upstream, api);
  if (target === upstream && (model.route?.wireProtocol ?? runtimeWire) === wireProtocol) return model;
  return { ...model, route: { ...model.route, baseUrl: target, wireProtocol } };
}


function profileMatches(profile: ModelInterfaceProfile, presetId: string, modelId: string, baseUrl: string, explicitBinding = false): boolean {
  return profile.providerId === presetId && !profile.retired &&
    (explicitBinding || !profile.modelIds || profile.modelIds.includes(modelId)) &&
    [...profile.inputBaseUrls, profile.baseUrl].some(input => clean(input) === clean(baseUrl));
}

/** Enumerate this product's transports only. Does not add account members, change
 * auth strategy or copy credentials. Unknown required behaviors exclude one binding. */
export function availableModelInterfaces(
  registry: ModelRegistry | undefined, presetId: string, modelId: string,
  baseUrl: string, agent: AgentKind, capabilities: readonly string[] = MODEL_INTERFACE_CAPABILITIES,
): ModelInterfaceSnapshot[] {
  if (!registry || registry.schemaVersion < 6) return [];
  const matches = registry.models.flatMap(entry => entry.routes
    .filter(route => route.providerId === presetId && route.modelId === modelId)
    .map(route => ({ entry, route })));
  if (matches.some(({entry}) => entry.status === 'retired') || matches.length > 1) return [];
  const match = matches[0];
  const profiles = registry.interfaceProfiles ?? [];
  const bindings: ModelInterfaceBinding[] = match?.route.interfaces ?? profiles
    .filter(profile => profileMatches(profile, presetId, modelId, baseUrl))
    .map(profile => ({ profileId: profile.id }));
  const order = match?.route.preferredInterfaces?.[agent];
  const candidates = bindings.flatMap(binding => {
    const profile = profiles.find(p => p.id === binding.profileId);
    if (!profile || binding.retired || !profileMatches(profile, presetId, modelId, baseUrl, !!match?.route.interfaces) ||
        !PI_MODEL_APIS.some(api => api === profile.api)) return [];
    const required = [`api:${profile.api}`, ...(profile.requires ?? []), ...(binding.requires ?? []),
      ...(binding.compatibility ?? profile.compatibility ?? [])];
    if (required.some(capability => !capabilities.includes(capability))) return [];
    return [{ profileId: profile.id, providerId: presetId, revision: registry.updatedAt,
      api: profile.api as NonNullable<ProviderRuntimeModelConfig['api']>,
      wireModelId: binding.wireModelId ?? modelId,
      route: { baseUrl: profile.baseUrl, wireProtocol: providerWireProtocolForApi(profile.api)!,
        ...(profile.requestPath ? { requestPath: profile.requestPath } : {}) },
      defaults: mergeModelMetadata(match?.route.defaults, profile.defaults, binding.defaults),
      compatibility: binding.compatibility ?? profile.compatibility ?? [],
      preferred: order ? order.includes(profile.id) : !!profile.defaultFor?.includes(agent),
      ...(match?.entry.nativeApis !== undefined ? { nativeApis: match.entry.nativeApis } : {}),
    }];
  });
  return candidates.sort((a,b) => {
    const rank = (p: ModelInterfaceSnapshot) => order?.includes(p.profileId) ? order.indexOf(p.profileId) : p.preferred ? 0 : 10000;
    return rank(a)-rank(b);
  });
}

export function providerInterfaceDefaultRoute(presetId: string, agent: AgentKind, baseUrl: string, registry: ModelRegistry = bundledRegistry) {
  const profile = (registry.interfaceProfiles ?? []).find(p => p.providerId === presetId &&
    !p.retired && !p.modelIds && p.defaultFor?.includes(agent) &&
    [...p.inputBaseUrls, p.baseUrl].some(input => clean(input) === clean(baseUrl)));
  const wireProtocol = profile && providerWireProtocolForApi(profile.api);
  return profile && wireProtocol ? { baseUrl: profile.baseUrl, wireProtocol } : undefined;
}

export function declaredModelInterface(presetId: string, modelId: string, registry: ModelRegistry = bundledRegistry) {
  const profiles = (registry.interfaceProfiles ?? []).filter(p => p.providerId === presetId && !p.retired && p.modelIds?.includes(modelId));
  if (profiles.length !== 1 || !PI_MODEL_APIS.some(api => api === profiles[0].api)) return undefined;
  return { api: profiles[0].api as NonNullable<ProviderRuntimeModelConfig['api']>, baseUrl: profiles[0].baseUrl };
}

/** One selector for imports, saved connections and runtime projections. Derived
 * selections never replace userModelConfig; explicit custom endpoints stay intact. */
export function providerInterfaceModelRoute<T extends ProviderRuntimeModelConfig>(
  model: T, agent: AgentKind, presetId: string | undefined, baseUrl: string, managed = false,
  registry: ModelRegistry = bundledRegistry,
): T {
  if (!presetId || model.route?.requestPath) return model;
  const choices = availableModelInterfaces(registry, presetId, model.id, baseUrl, agent);
  const declared = registry.models.some(e => e.routes.some(r => r.providerId === presetId && r.modelId === model.id && r.interfaces !== undefined));
  if (!choices.length) {
    const inScope = registry.interfaceProfiles?.some(p => p.providerId === presetId &&
      [...p.inputBaseUrls, p.baseUrl].some(url => clean(url) === clean(baseUrl)));
    return inScope && (declared || (model.interfaceId && model.interfaceId !== 'auto'))
      ? { ...model, interfaceUnavailable: true, availableInterfaces: [] } : model;
  }
  // Custom per-model origins/paths are outside the template's credential scope.
  if (model.route && !choices.some(p => {
    const profile = registry.interfaceProfiles?.find(item => item.id === p.profileId);
    return [p.route.baseUrl, ...(profile?.inputBaseUrls ?? [])]
      .some(input => clean(input) === clean(model.route!.baseUrl));
  })) return model;
  const automatic = model.interfaceId === 'auto';
  // Existing Pi adapter declarations remain authoritative until a Server binding
  // explicitly replaces them; a product's generic default must not flatten them.
  const keepManagedPiApi = managed && agent === 'pi' && !declared;
  const explicitApi = (!managed || keepManagedPiApi) && !automatic && (model.api ?? model.piApi ??
    (model.route?.wireProtocol === 'openai-chat' ? 'openai-completions' : model.route?.wireProtocol));
  const legacyDefault = explicitApi && (registry.interfaceProfiles ?? []).some(p =>
    p.legacyApis?.includes(explicitApi) && profileMatches(p, presetId, model.id, baseUrl))
    ? choices.find(p => p.preferred) : undefined;
  const selected = model.interfaceId && !automatic ? choices.find(p => p.profileId === model.interfaceId)
    : explicitApi ? legacyDefault ?? choices.find(p => p.api === explicitApi)
    : choices.find(p => p.preferred) ?? (declared ? choices[0] : undefined);
  if (model.interfaceId && !automatic && !selected) return { ...model, interfaceUnavailable: true, availableInterfaces: choices };
  if (!selected) return model;
  return { ...model, ...(managed ? { interfaceId: selected.preferred ? 'auto' : selected.profileId } : {}), api: selected.api, ...(agent === 'pi' ? { piApi: selected.api } : {}),
    route: selected.route, selectedInterface: selected, availableInterfaces: choices,
  };
}

export function hasDeclaredProviderInterface(model: ProviderRuntimeModelConfig, agent: AgentKind, presetId: string | undefined, baseUrl: string, registry: ModelRegistry = bundledRegistry): boolean {
  // Older servers cannot declare interface profiles. Retain the bundled proof
  // for metadata on an already selected route; never fill an empty/retired V6
  // directory or use this fallback to select a different execution interface.
  const declarations = registry.schemaVersion < 6 ? bundledRegistry : registry;
  return !!presetId && availableModelInterfaces(declarations, presetId, model.id, baseUrl, agent)
    .some(p => p.api === model.api && clean(p.route.baseUrl) === clean(model.route?.baseUrl ?? baseUrl));
}

/** Apply one accepted execution snapshot to every bridge/SDK consumer. */
export function modelWithInterface(model: CatalogModel, selected?: ModelInterfaceSnapshot): CatalogModel {
  return selected ? { ...applyModelMetadata(model, selected.defaults), interfaceUnavailable: false, api: selected.api, piApi: selected.api,
    route: selected.route, selectedInterface: selected } : model;
}
