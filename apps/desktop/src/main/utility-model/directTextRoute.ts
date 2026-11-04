import {
  isOpenAiSubscriptionProvider,
  resolvePiModelRoute,
  type AgentKind,
  type CatalogModel,
  type Provider,
  type RoutingDescriptor,
} from '@cindy/model-providers';

/** Subscription adapters own their endpoints and authentication; never treat them as BYOK. */
export function usesDirectTextRoute(provider: Provider): boolean {
  return provider.source !== 'builtin'
    && !isOpenAiSubscriptionProvider(provider)
    && provider.auth.native !== 'claude'
    && provider.auth.native !== 'xai';
}

/** Shared by auxiliary selection and HTTP dispatch. The runtime identifies the stored
 * connection/credential, not an agent process to launch. Reuse the portable API resolver
 * so SDK-only APIs cannot accidentally fall through to Responses. */
export function resolveDirectTextRoute(
  provider: Provider,
  agent: AgentKind,
  model: CatalogModel | undefined,
): RoutingDescriptor | null {
  const routing = provider.routing[agent];
  if (!provider.agents.includes(agent) || !routing || routing.disabled) return null;
  if (!['api-key-header', 'oauth-token', 'none'].includes(routing.authStrategy)) return null;
  const defaultWire = routing.wireProtocol
    ?? (agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
  const target = resolvePiModelRoute(model, { baseUrl: routing.upstream, wireProtocol: defaultWire });
  if (!target?.baseUrl.trim()) return null;
  // Retain legacy connection paths when the model restates the same target.
  // An endpoint or protocol switch must not inherit a path for a different API.
  const requestPath = target.requestPath
    ?? (target.baseUrl === routing.upstream && target.wireProtocol === defaultWire ? routing.requestPath : undefined);
  return { ...routing, upstream: target.baseUrl, wireProtocol: target.wireProtocol, requestPath };
}
