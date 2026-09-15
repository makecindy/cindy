import { trimTrailingSlashes } from '@cindy/model-compat/url';
import { SERVER_CATALOG } from './builtin.js';
import { compatibilityProtocol } from '@cindy/model-compat/protocol';
import type { AgentKind, ProviderPreset, ProviderRuntimeModelConfig, ProviderWireProtocol } from './types.js';

type Route = { baseUrl: string; api: string; inputs: string[] };
const clean = (value: string) => trimTrailingSlashes(value);

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

export function providerInterfaceDefaultRoute(presetId: string, agent: AgentKind, baseUrl: string) {
  const route = contract(presetId, agent);
  return route && [...route.inputs, route.baseUrl].some(input => clean(input) === clean(baseUrl))
    ? { baseUrl: route.baseUrl, wireProtocol: providerWireProtocolForApi(route.api)! } : undefined;
}
function contract(presetId: string, agent: AgentKind): Route | undefined {
  return SERVER_CATALOG.presets?.find(p => p.id === presetId)?.interfaceDefaults?.[agent];
}

export function declaredModelInterface(presetId: string, modelId: string) {
  return SERVER_CATALOG.presets?.find(p => p.id === presetId)?.modelInterfaces?.[modelId];
}

/** Correct generated catalog routes and their stored imports. Explicit custom
 * paths and unrelated hosts/products (including subscription endpoints) stay put. */
export function providerInterfaceModelRoute<T extends ProviderRuntimeModelConfig>(
  model: T, agent: AgentKind, presetId: string | undefined, baseUrl: string, managed = false,
): T {
  if (!presetId || model.route?.requestPath) return model;
  const specific = declaredModelInterface(presetId, model.id);
  if (specific) {
    const allowed = specific.inputs.map(clean);
    if (!allowed.includes(clean(baseUrl)) || (model.route && !allowed.includes(clean(model.route.baseUrl)))) return model;
    if (!managed && ((model.api && model.api !== 'openai-completions') || (model.piApi && model.piApi !== 'openai-completions') || (model.route && model.route.wireProtocol !== 'openai-chat'))) return model;
    return { ...model, api: specific.api, ...(agent === 'pi' ? { piApi: specific.api } : {}), route: {
      baseUrl: specific.baseUrl, wireProtocol: providerWireProtocolForApi(specific.api) ?? 'openai-chat',
    } };
  }
  if (agent === 'pi') return model;
  if (managed && !model.api && !model.piApi && !model.route) return model;
  const route = contract(presetId, agent);
  if (!route || ![...route.inputs, route.baseUrl].some(input => clean(input) === clean(baseUrl))) return model;
  // Stored legacy Pi projections used Chat. Do not overwrite explicit non-Chat choices.
  if (!managed && model.api && model.api !== 'openai-completions') return model;
  if (model.route) {
    if (!managed && model.route.wireProtocol !== 'openai-chat') return model;
    const declaredBases = new Set([...route.inputs, route.baseUrl,
      ...Object.values(SERVER_CATALOG.presets?.find(p => p.id === presetId)?.runtimes ?? {}).flatMap(rt => rt ? [rt.baseUrl] : []),
    ].map(clean));
    if (!declaredBases.has(clean(model.route.baseUrl))) return model;
  }
  return { ...model, api: route.api as NonNullable<ProviderRuntimeModelConfig['api']>, route: { baseUrl: route.baseUrl,
    wireProtocol: providerWireProtocolForApi(route.api) ?? 'openai-chat',
  } };
}

export function hasDeclaredProviderInterface(model: ProviderRuntimeModelConfig, agent: AgentKind, presetId: string | undefined, baseUrl: string): boolean {
  const route = presetId ? contract(presetId, agent) : undefined;
  return !!route && agent !== 'pi' && model.api === route.api && !model.route?.requestPath
    && [...route.inputs, route.baseUrl].some(input => clean(input) === clean(baseUrl))
    && clean(model.route?.baseUrl ?? baseUrl) === clean(route.baseUrl);
}
