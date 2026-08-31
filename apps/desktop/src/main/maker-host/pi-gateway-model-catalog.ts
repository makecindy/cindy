import type {
  Catalog,
  PiModelApi,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import piModelCatalogJson from '@cindy/model-providers/pi-model-catalog' with { type: 'json' };

export interface BundledPiGatewayModelProfile {
  api: PiModelApi;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

interface PiCatalogRow extends BundledPiGatewayModelProfile {
  id: string;
  provider: string;
}

const catalog = piModelCatalogJson as unknown as {
  providers: Record<string, PiCatalogRow[]>;
};
const rows = Object.values(catalog.providers).flat();

const gatewayModelIdsByApi: Record<PiModelApi, ReadonlySet<string>> = {
  'anthropic-messages': new Set([
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'anthropic/claude-opus-5',
  ]),
  'openai-responses': new Set([
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'codex/gpt-5.4',
    'codex/gpt-5.4-mini',
    'codex/gpt-5.5',
    'codex/gpt-5.5:auto',
    'codex/gpt-5.6-luna',
    'codex/gpt-5.6-sol',
    'codex/gpt-5.6-terra',
    'meta/muse-spark-1.2',
    'x-ai-grok/grok-4.6',
    'x-ai/grok-4.5',
    'x-ai/grok-4.6',
  ]),
  'openai-completions': new Set([
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-pro',
    'moonshot/kimi-k3',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k3',
    'qwen/qwen3.7-max',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.8-flash',
    'qwen/qwen3.8-max',
    'tencent/hy3',
    'z-ai/glm-5.1',
    'z-ai/glm-5.2',
    'z-ai/glm-5.3',
    'z-ai/glm-5.3-flash',
  ]),
  'google-generative-ai': new Set([
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'google/gemini-3.6-flash',
    'google/gemini-3.7-flash',
  ]),
};

function normalizeModelId(modelId: string): string {
  return modelId.replace(/\[1m\]$/, '');
}

function piApiFromWireProtocol(protocol: ProviderWireProtocol | undefined): PiModelApi | undefined {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
      return 'openai-completions';
    default:
      return undefined;
  }
}

function catalogModelApi(
  model: ProviderRuntimeModelConfig,
  defaultProtocol: ProviderWireProtocol | undefined,
): PiModelApi | undefined {
  return model.piApi ?? piApiFromWireProtocol(model.route?.wireProtocol ?? defaultProtocol);
}

function collapseCatalogApis(apis: readonly PiModelApi[]): PiModelApi | null | undefined {
  const distinct = [...new Set(apis)];
  if (distinct.length === 0) return undefined;
  return distinct.length === 1 ? distinct[0] : null;
}

function routedCatalogApis(
  catalog: Catalog,
  providerId: string,
  modelId: string,
): PiModelApi[] {
  if (providerId === 'xd') return [];
  const apis: PiModelApi[] = [];
  const provider = catalog.providers.find((entry) => entry.id === providerId);
  const providerModel = provider?.models.pi?.find((model) => model.id === modelId);
  const providerApi = providerModel
    ? catalogModelApi(providerModel, provider?.routing.pi?.wireProtocol)
    : undefined;
  if (providerApi) apis.push(providerApi);

  const preset = catalog.presets?.find((entry) => entry.id === providerId);
  const runtime = preset?.runtimes.pi;
  const presetModel = runtime?.models.find((model) => model.id === modelId);
  const presetApi = presetModel ? catalogModelApi(presetModel, runtime?.wireProtocol) : undefined;
  if (presetApi) apis.push(presetApi);
  return apis;
}

/**
 * Resolve the Pi protocol declared by Cindy Server's downloaded Catalog.
 *
 * Only Registry-linked provider routes are identity proof. A matching model string in an unrelated
 * preset/provider is not enough: aggregators and native providers can expose the same wire id over
 * different protocols. Bare-id and standalone namespaced-id matching are therefore both forbidden.
 *
 * `null` means the server Catalog contains conflicting declarations for the same proven identity;
 * callers must fail closed instead of falling through to a lower-priority source.
 */
function catalogPiGatewayRegistryEntries(catalog: Catalog, gatewayModelId: string) {
  const normalized = normalizeModelId(gatewayModelId);
  return (
    catalog.modelRegistry?.models.filter((entry) =>
      entry.routes.some((route) => route.providerId === 'xd' && route.modelId === normalized),
    ) ?? []
  );
}

/** True only for an exact XD Registry tombstone from Cindy Server. */
export function isCatalogPiGatewayModelRetired(catalog: Catalog, gatewayModelId: string): boolean {
  return catalogPiGatewayRegistryEntries(catalog, gatewayModelId).some(
    (entry) => entry.status === 'retired',
  );
}

export function resolveCatalogPiGatewayModelApi(
  catalog: Catalog,
  gatewayModelId: string,
): PiModelApi | null | undefined {
  const registryEntries = catalogPiGatewayRegistryEntries(catalog, gatewayModelId);
  if (registryEntries.some((entry) => entry.status === 'retired')) return null;
  const routed = registryEntries.flatMap((entry) =>
    entry.routes.flatMap((route) => routedCatalogApis(catalog, route.providerId, route.modelId)),
  );
  return collapseCatalogApis(routed);
}

const gatewayCatalogIdentityOverrides = new Map<string, { provider: string; modelId: string }>([
  ...[
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
  ].map((id) => [id, { provider: 'anthropic', modelId: id }] as const),
  ['anthropic/claude-opus-5', { provider: 'anthropic', modelId: 'claude-opus-5' }],
  ...[
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ].flatMap((id) => [
    [id, { provider: 'openai', modelId: id }] as const,
    [`codex/${id}`, { provider: 'openai', modelId: id }] as const,
  ]),
  ['codex/gpt-5.5:auto', { provider: 'openai', modelId: 'gpt-5.5' }],
  ...[
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
  ].map((id) => [id, { provider: 'google', modelId: id }] as const),
  ['google/gemini-3.6-flash', { provider: 'google', modelId: 'gemini-3.6-flash' }],
  ['google/gemini-3.7-flash', { provider: 'google', modelId: 'gemini-3.7-flash' }],
  ...['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].map(
    (id) => [`deepseek/${id}`, { provider: 'deepseek', modelId: id }] as const,
  ),
  ['moonshot/kimi-k3', { provider: 'moonshotai', modelId: 'kimi-k3' }],
  ['moonshotai/kimi-k2.6', { provider: 'moonshotai', modelId: 'kimi-k2.6' }],
  ['moonshotai/kimi-k3', { provider: 'moonshotai', modelId: 'kimi-k3' }],
  ...['qwen3.7-max', 'qwen3.8-27b', 'qwen3.8-flash', 'qwen3.8-max'].map(
    (id) => [`qwen/${id}`, { provider: 'qwen-token-plan-cn', modelId: id }] as const,
  ),
  ...['glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash'].map(
    (id) => [`z-ai/${id}`, { provider: 'zai', modelId: id }] as const,
  ),
  ...['grok-4.5', 'grok-4.6'].flatMap((id) => [
    [`x-ai/${id}`, { provider: 'xai', modelId: id }] as const,
    [`x-ai-grok/${id}`, { provider: 'xai', modelId: id }] as const,
  ]),
]);

function authoritativeGatewayApi(modelId: string): PiModelApi | undefined {
  const normalized = normalizeModelId(modelId);
  for (const [api, ids] of Object.entries(gatewayModelIdsByApi) as Array<
    [PiModelApi, ReadonlySet<string>]
  >) {
    if (ids.has(normalized)) return api;
  }
  return undefined;
}

/** Preferred exact provider/model identity in Pi's complete bundled catalog. */
export function resolveBundledPiGatewayCatalogIdentity(
  modelId: string,
): { provider: string; modelId: string } | undefined {
  const normalized = normalizeModelId(modelId);
  const explicit = gatewayCatalogIdentityOverrides.get(normalized);
  if (explicit) return explicit;
  const direct = rows.find((row) => `${row.provider}/${row.id}` === normalized);
  return direct ? { provider: direct.provider, modelId: direct.id } : undefined;
}

/**
 * Resolve the current Gateway model through Cindy's version-matched Pi table.
 *
 * Cindy Server's downloaded Catalog is checked before this function. This local table is the
 * second authority and may only resolve exact, allowlisted identities. Cindy AI Gateway metadata
 * is a last-resort hint after both higher-priority sources are absent. Unknown identities fail
 * closed instead of guessing a provider or protocol.
 */
export function resolveBundledPiGatewayModelProfile(
  modelId: string,
): BundledPiGatewayModelProfile | undefined {
  const identity = resolveBundledPiGatewayCatalogIdentity(modelId);
  const matched = identity
    ? rows.find((row) => row.provider === identity.provider && row.id === identity.modelId)
    : undefined;
  const api = matched?.api ?? authoritativeGatewayApi(modelId);
  if (!api) return undefined;
  // Never borrow compat by bare ID across providers. An allowlisted Gateway identity may still
  // use its locally selected API, but provider-specific serialization metadata requires an exact
  // canonical provider/model row (or the exact binary probe in pi-host).
  return {
    api,
    ...(matched?.compat ? { compat: structuredClone(matched.compat) } : {}),
    ...(matched?.samplingParams ? { samplingParams: structuredClone(matched.samplingParams) } : {}),
    ...(matched?.thinkingLevelMap ? { thinkingLevelMap: { ...matched.thinkingLevelMap } } : {}),
  };
}
