import { compatibilityProtocol } from '@cindy/model-compat/protocol';
import { PI_MODEL_APIS } from './types.js';
import type {
  AgentKind,
  CatalogModel,
  PiModelApi,
  Provider,
  ProviderWireProtocol,
} from './types.js';

function apiFromWireProtocol(protocol: ProviderWireProtocol | undefined): PiModelApi | null {
  return protocol === 'openai-chat' ? 'openai-completions' : (protocol ?? null);
}

/** Protocol comparison for one provider's logical row. Never borrow another provider's model. */
export function modelProtocolComparison(
  provider: Pick<Provider, 'id' | 'routing'> & Partial<Pick<Provider, 'source'>>,
  models: Partial<Record<AgentKind, CatalogModel>>,
) {
  // Canonical protocol is model metadata, never reverse-engineered from a harness configuration.
  const declared = Object.values(models)
    .map((m) => m.nativeApi)
    .filter((api): api is PiModelApi | null => api === null || PI_MODEL_APIS.some(value => value === api));
  const reference: PiModelApi | null = declared.length
    ? new Set(declared).size === 1
      ? declared[0]!
      : null
    : provider.id === 'anthropic' && models['claude-code']
      ? 'anthropic-messages'
      : provider.id === 'openai' && models.codex
        ? 'openai-responses'
        : null;
  const declaredApis = Object.values(models).map(m => m.nativeApis).filter(v => v !== undefined);
  const nativeApis = declaredApis.length ? declaredApis.every(v => JSON.stringify(v) === JSON.stringify(declaredApis[0]))
    ? declaredApis[0] : null : reference ? [reference] : null;
  const protocolOf = (api: string | null | undefined) => compatibilityProtocol(api) ?? api ?? null;
  const harnessApi = (agent: AgentKind, api: PiModelApi | null): PiModelApi | null =>
    agent === 'pi' ? api : agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
  /** Compatibility mode means Cindy's local conversion only; any API the upstream offers is used as is. */
  const pathFor = (agent: AgentKind, api: PiModelApi | null | undefined): 'direct' | 'local' | 'unknown' => {
    if (!api) return 'unknown';
    return protocolOf(api) === protocolOf(harnessApi(agent, api)) ? 'direct' : 'local';
  };
  // Built-in subscriptions (ChatGPT, SuperGrok, Claude) speak their vendor's own API. A
  // cross-vendor engine there reaches it through Cindy's local bridge without declaring a
  // per-model API, so the vendor API is the real upstream. Cindy AI is a gateway, not a bridge.
  const subscriptionBridge = provider.source === 'builtin' && provider.id !== 'xd';
  const forAgent = (agent: AgentKind) => {
    const model = models[agent];
    if (!model) return null;
    const routing = provider.routing?.[agent];
    // Fixed-protocol hosts execute the resolved route, not raw model API metadata.
    // These can differ for an explicitly configured request path. Pi instead
    // selects its SDK adapter from the model API before consulting HTTP defaults.
    const connection = apiFromWireProtocol(routing?.wireProtocol ?? (
      routing?.authStrategy && agent !== 'pi'
        ? agent === 'codex' ? 'openai-responses' : 'anthropic-messages'
        : undefined
    ));
    const routeApi = apiFromWireProtocol(model.route?.wireProtocol);
    const subscriptionApi = subscriptionBridge && reference
      ? model.api ?? (agent === 'pi' ? model.piApi : undefined) ?? reference
      : null;
    const outbound = subscriptionApi ?? (agent === 'pi'
      ? model.api ?? model.piApi ?? routeApi ?? connection
      : routeApi ?? connection ?? model.api ?? null);
    // Stored customization is separate from the effective source: a custom
    // path can make stale API metadata inactive, but it must still be resettable.
    const customized = model.protocolCustomized ?? Boolean(
      (model.userModelConfig?.interfaceId && model.userModelConfig.interfaceId !== 'auto') ||
      model.userModelConfig?.api || model.userModelConfig?.piApi || model.userModelConfig?.route,
    );
    const usesModelProtocol = agent === 'pi'
      ? Boolean(model.api || model.piApi || routeApi)
      : Boolean(routeApi || (model.api && model.api === outbound));
    const source: 'model' | 'catalog' | 'connection' = usesModelProtocol
      ? customized ? 'model' : 'catalog'
      : 'connection';
    const harness = harnessApi(agent, outbound);
    const path = pathFor(agent, outbound);
    const localConversion = path === 'local';
    return {
      harness,
      outbound,
      connection,
      source,
      customized,
      localConversion,
      path,
      mode: localConversion
        ? ('compatibility' as const)
        : outbound
          ? ('matching' as const)
          : ('unknown' as const),
    };
  };
  /** APIs this source offers for the model: bound interfaces plus every engine's declared outbound
   * API (local conversion changes the engine side, not what the upstream serves). The
   * manufacturer's own API is not evidence that a channel offers it. */
  const offered = new Set<string>([
    ...Object.values(models).flatMap(model => (model.availableInterfaces ?? []).map(item => item.api)),
    ...(Object.keys(models) as AgentKind[]).flatMap(agent => {
      const protocol = forAgent(agent);
      return protocol?.outbound ? [protocol.outbound] : [];
    }),
  ]);
  const order = ['anthropic', 'openai-responses', 'openai-chat', 'google'];
  const upstreamApis = [...new Map([...offered].map(api => [protocolOf(api), api as PiModelApi])).entries()]
    .sort(([a], [b]) => (order.indexOf(a ?? '') + 1 || 99) - (order.indexOf(b ?? '') + 1 || 99))
    .map(([, api]) => api);
  return { reference, nativeApis, upstreamApis, pathFor, forAgent };
}

/** Default-on engines use an API the upstream offers, without Cindy's local conversion. */
export function nativeModelAgents(
  provider: Pick<Provider, 'id' | 'routing'> & Partial<Pick<Provider, 'source'>>,
  models: Partial<Record<AgentKind, CatalogModel>>,
): AgentKind[] {
  const comparison = modelProtocolComparison(provider, models);
  return (Object.keys(models) as AgentKind[]).filter(agent => {
    const protocol = comparison.forAgent(agent);
    return !!protocol?.outbound && protocol.mode === 'matching';
  });
}
