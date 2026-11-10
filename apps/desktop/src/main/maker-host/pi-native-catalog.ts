/** Pure Pi catalog projection shared by the desktop and headless launchers.
 * Keep protocol, endpoint, model limits and per-provider credential isolation together. */
import { providerPresetModelRecord, providerModelAdapterId, providerBaseUrlForApi } from '@cindy/model-providers';
import type { PiNativeApi, PiNativeModelSpec, PiNativeProviderSpec, PiNativeProvidersResult } from '@cindy/maker-core';
import { PI_REASONING_EFFORTS, resolvePiModelRoute, runtimeCustomProviderId } from '@cindy/model-providers';
import { providerCatalogForPi, providerModelRecord, providerModelGenerationRecord } from '@cindy/model-providers';
import type { Catalog, ModelCost, PiModelApi, PiReasoningEffort, ProviderWireProtocol } from '@cindy/model-providers';
import { matchesManagedOllamaFingerprint } from '../../shared/localModelRuntime.js';
import { applyQwen38NativeOverlay, shouldApplyQwen38Overlay } from '../local-model-runtime/qwenProfile.js';
import { hostCredentialEndpointAllowed } from './pi-provider-transport.js';
import { withProviderAppAttribution } from './provider-app-attribution.js';

export const PI_PROVIDER_HEADER = 'x-cindy-pi-provider-id';

export interface PiBundledModelInfo {
  id: string;
  api: PiNativeApi;
  baseUrl?: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: PiNativeModelSpec['thinkingLevelMap'];
  input: Array<'text' | 'image'>;
  contextWindow: number;
  maxTokens: number;
  cost?: PiNativeModelSpec['cost'];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}

export type PiBundledModelCatalog = ReadonlyMap<string, ReadonlyMap<string, PiBundledModelInfo>>;

export const PI_NATIVE_APIS = new Set<PiNativeApi>([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
  'google-generative-ai',
  'openai-codex-responses',
  'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations',
]);

export function piSubscriptionHeaders(providerId: string): Record<string, string> {
  return {
    'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
    'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
    [PI_PROVIDER_HEADER]: providerId,
  };
}

export function catalogCostForPiNative(cost: ModelCost | undefined): PiNativeModelSpec['cost'] {
  if (
    !cost ||
    (typeof cost.input !== 'number' &&
      typeof cost.output !== 'number' &&
      typeof cost.cacheRead !== 'number' &&
      typeof cost.cacheWrite !== 'number')
  ) {
    return undefined;
  }
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tiers ? { tiers: cost.tiers.map(tier => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input ?? cost.input ?? 0,
      output: tier.output ?? cost.output ?? 0,
      cacheRead: tier.cacheRead ?? cost.cacheRead ?? 0,
      cacheWrite: tier.cacheWrite ?? cost.cacheWrite ?? 0,
    })) } : {}),
  };
}

export function catalogThinkingLevelMap(
  efforts: readonly string[],
  bundled: PiNativeModelSpec['thinkingLevelMap'] | undefined,
): NonNullable<PiNativeModelSpec['thinkingLevelMap']> {
  return Object.fromEntries(
    PI_REASONING_EFFORTS.map((effort) => [
      effort,
      efforts.includes(effort) ? (bundled?.[effort] ?? effort) : null,
    ]),
  );
}

export function wireProtocolToPiApi(wp: ProviderWireProtocol): PiNativeApi {
  switch (wp) {
    case 'google-generative-ai':
      return 'google-generative-ai';
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
      return 'openai-completions';
    default:
      throw new Error(`Unsupported PI wire protocol: ${String(wp)}`);
  }
}

export function urlOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function resolvePiBundledModelById(
  catalog: PiBundledModelCatalog | undefined,
  modelId: string,
  sourceBaseUrl?: string,
): PiBundledModelInfo | undefined {
  const candidates: PiBundledModelInfo[] = [];
  for (const models of catalog?.values() ?? []) {
    const model = models.get(modelId);
    if (model) candidates.push(model);
  }
  if (candidates.length === 0) return undefined;
  const sourceOrigin = urlOrigin(sourceBaseUrl);
  if (!sourceOrigin) return undefined;
  const sameOrigin = candidates.filter((model) => urlOrigin(model.baseUrl) === sourceOrigin);
  const exactBaseUrl = sameOrigin.filter((model) => model.baseUrl === sourceBaseUrl);
  if (exactBaseUrl.length === 1) return exactBaseUrl[0];
  return sameOrigin.length === 1 ? sameOrigin[0] : undefined;
}

export function piNativeKeyEnvVar(providerId: string): string {
  return `CINDY_PI_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export interface PiCatalogModel extends PiNativeModelSpec {
  provider: string;
  baseUrl: string;
}

export const piModelCatalog = providerCatalogForPi() as unknown as {
  generatedAt: string;
  providers: Record<string, PiCatalogModel[]>;
};

export function officialPiModels(providerId: string): PiNativeModelSpec[] | null {
  const models = piModelCatalog.providers[providerId];
  if (!models) return null;
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.headers && Object.keys(model.headers).length > 0 ? { headers: model.headers } : {}),
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    samplingParams: model.samplingParams,
  }));
}

export function officialPiRouteMatches(
  providerId: string,
  baseUrl: string,
  wireProtocol: ProviderWireProtocol | undefined,
): boolean {
  const models = piModelCatalog.providers[providerId];
  if (!models?.length) return false;
  const baseUrls = new Set(models.map((model) => model.baseUrl.replace(/\/+$/, '')));
  const apis = new Set(models.map((model) => model.api));
  return (
    baseUrls.size === 1 &&
    baseUrls.has(baseUrl.trim().replace(/\/+$/, '')) &&
    apis.size === 1 &&
    (wireProtocol === undefined || apis.has(wireProtocolToPiApi(wireProtocol)))
  );
}

export function anthropicRootForV1Endpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
        !/\/v1\/?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
      return undefined;
    }
    return url.origin + url.pathname.replace(/\/v1\/?$/, '');
  } catch {
    return undefined;
  }
}

export function buildPiNativeProvidersFromConfigs(
  configs: Array<{
    id: string;
    name: string;
    auth?: { method?: string; oauth?: unknown };
    runtimes: {
      pi?: {
        baseUrl: string;
        wireProtocol?: ProviderWireProtocol;
        requestPath?: string;
        headers?: Record<string, string>;
        piCatalogProviderId?: string;
        catalogPresetId?: string;
        models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          supportsImageInput?: boolean;
          reasoning?: boolean;
          reasoningEfforts?: PiReasoningEffort[];
          api?: PiModelApi;
          piApi?: PiModelApi;
          selectedInterface?: import('@cindy/model-providers').ModelInterfaceSnapshot;
          route?: {
            baseUrl: string;
            wireProtocol: ProviderWireProtocol;
            requestPath?: string;
          };
        }>;
      };
    };
  }>,
  readKey: (providerId: string, agent: string) => string | null,
  onSkip?: (id: string, reason: string) => void,
  bundledModelsByProvider?: PiBundledModelCatalog,
  resolvedCatalog?: Catalog,
  oauthProxyEndpoint?: string,
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const env: Record<string, string> = {};
  // 派生 env 名去重:CINDY_PI_KEY_<ID> 会把 `-`/`_` 归一,不同合法 id(my-vllm / my_vllm)
  // 可能塌缩到同名 → 后写覆盖 → 一个 provider 的 key 被发往另一个端点(凭证串号)。撞名时
  // 追加 _2/_3 保证每个 provider 拿到独立 env 名。
  const usedEnvVars = new Set<string>();
  const uniqueEnvVar = (id: string): string => {
    const base = piNativeKeyEnvVar(id);
    if (!usedEnvVars.has(base)) {
      usedEnvVars.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}`;
      if (!usedEnvVars.has(candidate)) {
        usedEnvVars.add(candidate);
        return candidate;
      }
    }
  };
  for (const cfg of configs) {
    const savedRuntime = cfg.runtimes.pi;
    if (!savedRuntime) continue;
    const resolvedProvider = resolvedCatalog?.providers.find(p => p.id === runtimeCustomProviderId(cfg.id));
    const rt = { ...savedRuntime, models: savedRuntime.models.map(model => {
      const resolved = resolvedProvider?.models.pi?.find(item => item.id === model.id);
      return resolved?.selectedInterface ? { ...model, api: resolved.api, piApi: resolved.piApi,
        route: resolved.route, selectedInterface: resolved.selectedInterface } : model;
    }) };

    const authMethod = cfg.auth?.method ?? 'apiKey';
    if (authMethod === 'oauth' && (!cfg.auth?.oauth || !oauthProxyEndpoint)) {
      onSkip?.(cfg.id, 'oauth proxy not ready for pi native');
      continue;
    }
    const managedOllama = matchesManagedOllamaFingerprint({
      id: cfg.id,
      authMethod,
      runtimes: cfg.runtimes,
    });
    const runtimeApi =
      rt.wireProtocol === undefined ? undefined : wireProtocolToPiApi(rt.wireProtocol);
    // Protocol authority, in order: per-model override, explicit endpoint default,
    // strictly same-origin PI bundled knowledge, then an explicitly matched official
    // PI catalog. Missing protocol is not Chat: one unresolved model makes the whole
    // provider unusable so PI cannot silently send it to a guessed endpoint shape.
    const bundledModels = rt.models.map((model) => {
      // 显式 runtime 协议决定端点形状，但不应阻止同源 Pi 目录补齐图片、输出上限等能力。
      // 只有 per-model piApi 明确改写协议时才不借用；协议冲突也必须隔离。
      if (model.piApi) return undefined;
      const bundled = resolvePiBundledModelById(bundledModelsByProvider, model.id, rt.baseUrl);
      if (!bundled || !runtimeApi || bundled.api === runtimeApi) return bundled;
      return undefined;
    });
    const official =
      rt.piCatalogProviderId &&
      officialPiRouteMatches(rt.piCatalogProviderId, rt.baseUrl, rt.wireProtocol)
        ? officialPiModels(rt.piCatalogProviderId)
        : null;
    const officialById = new Map((official ?? []).map((model) => [model.id, model]));
    // The pinned binary predates Astra. Exact public API endpoint/protocol matches
    // may use our catalog addition even when the user entered the endpoint by hand.
    // Never lend subscription capabilities to an API key or another endpoint.
    const openaiAddition = !rt.piCatalogProviderId &&
      runtimeApi === 'openai-responses' &&
      officialPiRouteMatches('openai', rt.baseUrl, rt.wireProtocol)
        ? officialPiModels('openai')?.find((model) => model.id === 'gpt-6-astra')
        : undefined;
    // Use the same effective endpoint for catalog compatibility as for the SDK.
    // Explicit model routes and request paths keep their existing path semantics.
    const catalogUpstreams = rt.models.map(model => {
      const upstream = model.route?.baseUrl ?? rt.baseUrl;
      const api = model.api ?? model.piApi ?? model.route?.wireProtocol ?? rt.wireProtocol;
      return api === 'anthropic-messages' && authMethod !== 'oauth' && !rt.requestPath && !model.route
        ? anthropicRootForV1Endpoint(upstream) ?? upstream : upstream;
    });
    const standardModels = rt.models.map((model, index) => {
      if (model.route?.requestPath || rt.requestPath) return undefined;
      const upstream = catalogUpstreams[index]!;
      const row = providerModelRecord(model.id, upstream,
        model.api ?? model.piApi ?? (model.route ? model.route.wireProtocol : rt.wireProtocol),
        !model.api && !model.piApi && !model.route)
        ?? ((model.api ?? model.piApi) ? providerPresetModelRecord(rt.catalogPresetId, model.id, model.api ?? model.piApi, upstream) : undefined)
        ?? providerModelGenerationRecord(model.id, upstream,
          model.api ?? model.piApi ?? (model.route ? model.route.wireProtocol : rt.wireProtocol), rt.catalogPresetId);
      if (!row || !PI_NATIVE_APIS.has(row.execution.pi.api as PiNativeApi)) return undefined;
      return {
        id: row.id, name: row.name, baseUrl: row.upstream,
        ...row.execution.pi, api: row.execution.pi.api as PiModelApi,
        contextWindow: row.contextWindow, maxTokens: row.maxOutput,
        input: (row.modalities?.input ?? ['text']).filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
        reasoning: row.reasoning,
        cost: row.cost?.input !== undefined && row.cost.output !== undefined
          ? { input: row.cost.input, output: row.cost.output,
              cacheRead: row.cost.cacheRead ?? 0, cacheWrite: row.cost.cacheWrite ?? 0 }
          : undefined,
      };
    });
    const metadataModels = rt.models.map(
      (model, index) => standardModels[index] ?? bundledModels[index] ?? officialById.get(model.id) ??
        (model.id === openaiAddition?.id && !model.route &&
          (!model.piApi || model.piApi === openaiAddition.api) ? openaiAddition : undefined),
    );
    const modelApis = rt.models.map(
      (model, index) =>
        model.api ?? model.piApi ??
        (model.route ? wireProtocolToPiApi(model.route.wireProtocol) : undefined) ??
        resolvedCatalog?.providers.find(provider => provider.id === cfg.id)?.models.pi?.find(item => item.id === model.id)?.api ??
        standardModels[index]?.api ??
        runtimeApi ??
        metadataModels[index]?.api,
    );
    const unresolvedModelIndex = modelApis.findIndex((api) => api === undefined);
    if (unresolvedModelIndex >= 0) {
      onSkip?.(
        cfg.id,
        `pi protocol not configured for model '${rt.models[unresolvedModelIndex]!.id}'`,
      );
      continue;
    }
    const providerApi = runtimeApi ?? modelApis[0];
    if (!providerApi) {
      onSkip?.(cfg.id, 'pi protocol not configured for provider default');
      continue;
    }
    const headers =
      rt.headers && Object.keys(rt.headers).length > 0
        ? Object.fromEntries(
            Object.entries(rt.headers).map(([name, value]) => {
              const envVar = uniqueEnvVar(`${cfg.id}_HEADER_${name}`);
              env[envVar] = value;
              return [name, `$${envVar}`];
            }),
          )
        : undefined;
    let apiKeyEnvVar: string | undefined;
    if (authMethod === 'apiKey') {
      const key = readKey(cfg.id, 'pi');
      if (!key && !headers) {
        onSkip?.(cfg.id, 'apiKey provider missing pi key and custom headers');
        continue;
      }
      if (key) {
        apiKeyEnvVar = uniqueEnvVar(cfg.id);
        env[apiKeyEnvVar] = key;
      }
    }
    if (rt.models.some((model, index) => {
      const api = modelApis[index]!;
      if (api !== 'google-vertex' && api !== 'bedrock-converse-stream') return false;
      if (api === 'google-vertex' && apiKeyEnvVar) return false;
      return !hostCredentialEndpointAllowed(api, model.route?.baseUrl ?? rt.baseUrl);
    })) {
      onSkip?.(cfg.id, 'native SDK requires an approved cloud endpoint');
      continue;
    }
    const adapterIds = new Set(rt.models.flatMap((model, index) => {
      const api = modelApis[index];
      // The native ChatGPT subscription transport owns its authentication separately.
      if (!api || api === 'openai-codex-responses') return [];
      const upstream = catalogUpstreams[index]!;
      const row = providerModelRecord(model.id, upstream, api)
        ?? providerPresetModelRecord(rt.catalogPresetId, model.id, api, upstream)
        ?? providerModelGenerationRecord(model.id, upstream, api, rt.catalogPresetId);
      const adapter = row ? providerModelAdapterId(row, rt.catalogPresetId) : undefined;
      return adapter ? [adapter] : [];
    }));
    providers.push({
      ...(adapterIds.size === 1 ? { adapterProvider: [...adapterIds][0] } : {}),
      id: runtimeCustomProviderId(cfg.id),
      name: cfg.name,
      // The proxy already retains the supplier base path (e.g. /api/v1).
      // OpenAI SDKs append /chat/completions or /responses themselves.
      baseUrl: authMethod === 'oauth' ? oauthProxyEndpoint! : rt.baseUrl,
      ...(authMethod === 'oauth' ? { cacheIdentityBaseUrl: rt.baseUrl } : {}),
      api: providerApi,
      apiKeyEnvVar,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(authMethod === 'oauth' ? { headers: piSubscriptionHeaders(cfg.id) } : {}),
      models: rt.models.map((configuredModel, index) => {
        // Public/default/discovery/user precedence was resolved by the active catalog.
        // Carry those facts to the serializer instead of reintroducing SDK precedence.
        // Endpoint, protocol and credentials remain exclusively connection-owned.
        const runtimeProvider = resolvedCatalog?.providers.find(p => p.id === runtimeCustomProviderId(cfg.id));
        const catalogProvider = resolvedCatalog?.providers.find(p => p.id === cfg.id);
        const runtimeModel = runtimeProvider?.models.pi?.find(model => model.id === configuredModel.id);
        const catalogModel = catalogProvider?.models.pi?.find(model => model.id === configuredModel.id);
        const resolved = runtimeModel ?? catalogModel;
        const resolvedProvider = runtimeModel ? runtimeProvider : catalogProvider;
        const m = resolved ? {
          ...configuredModel,
          name: resolved.name,
          contextWindow: resolved.contextWindow,
          // A same-id built-in row is only a fallback. A user projection already
          // includes form edits and the higher-priority local catalog overrides.
          // Sparse user rows still inherit a declared catalog image capability.
          supportsImageInput: resolvedProvider?.source === 'user'
            ? resolved.supportsImageInput ?? configuredModel.supportsImageInput ?? catalogModel?.supportsImageInput
            : configuredModel.supportsImageInput ?? resolved.supportsImageInput,
          reasoning: resolved.efforts.length > 0,
          reasoningEfforts: resolved.efforts.filter((effort): effort is PiReasoningEffort =>
            (PI_REASONING_EFFORTS as readonly string[]).includes(effort)),
        } : configuredModel;
        const supportedEfforts = new Set(m.reasoningEfforts ?? []);
        const modelApi = modelApis[index]!;
        const bundledModel = metadataModels[index];
        const explicitRoute = resolvePiModelRoute(m, {
          baseUrl: rt.baseUrl,
          wireProtocol: rt.wireProtocol,
        });
        const explicitRouteApi = explicitRoute
          ? wireProtocolToPiApi(explicitRoute.wireProtocol)
          : undefined;
        // The HTTP bridge resolver discards a route whose protocol disagrees
        // with an explicit api/piApi override. Native SDK APIs return no bridge
        // route at all; their saved model endpoint remains authoritative.
        const matchingModelRoute = m.route && (!explicitRoute ||
          m.route.wireProtocol === explicitRoute.wireProtocol) ? m.route : undefined;
        // Bundled/official rows may lend capabilities, but never routing. Only an
        // explicit model route or a proven SDK path relationship may override baseUrl.
        // Google's public /v1beta/openai endpoint is one such relationship.
        const nativeGoogleBaseUrl =
          modelApi === 'google-generative-ai' && !m.route?.requestPath && !rt.requestPath
            ? providerBaseUrlForApi(rt.baseUrl, modelApi) : undefined;
        // Anthropic appends /v1/messages. A model without an effective route may
        // inherit /v1 from either runtime; matching saved routes remain
        // authoritative even when they equal the provider endpoint.
        const nativeAnthropicBaseUrl =
          modelApi === 'anthropic-messages' &&
          authMethod !== 'oauth' && !rt.requestPath && !matchingModelRoute
            ? anthropicRootForV1Endpoint(rt.baseUrl) : undefined;
        const modelBaseUrl =
          nativeAnthropicBaseUrl ?? (m.api && matchingModelRoute ? matchingModelRoute.baseUrl :
            m.route && explicitRouteApi === modelApi ? explicitRoute?.baseUrl : nativeGoogleBaseUrl);
        // Model-level defaults follow the final endpoint. Putting them on the
        // provider would leak them to a model routed to a different service.
        const modelHeaders = authMethod === 'oauth' ? bundledModel?.headers
          : withProviderAppAttribution(modelBaseUrl ?? rt.baseUrl, headers, bundledModel?.headers);
        const spec = {
          id: m.id,
          ...(m.selectedInterface ? { wireId: m.selectedInterface.wireModelId } : {}),
          ...(authMethod === 'oauth' ? { cacheIdentityBaseUrl: modelBaseUrl ?? rt.baseUrl } : {}),
          ...(resolved?.supportsFastMode !== undefined ? { supportsFastMode: resolved.supportsFastMode } : {}),
          ...(m.api || m.piApi || modelApi !== providerApi ? { api: modelApi } : {}),
          ...(authMethod === 'oauth'
            ? { baseUrl: oauthProxyEndpoint! }
            : modelBaseUrl && modelBaseUrl !== rt.baseUrl ? { baseUrl: modelBaseUrl } : {}),
          name: m.name ?? bundledModel?.name,
          // 下发文件明确写出的上下文优先；本地 Pi 目录只补缺失值。
          contextWindow: m.contextWindow ?? bundledModel?.contextWindow,
          ...(resolved?.maxOutput !== undefined || bundledModel?.maxTokens !== undefined
            ? { maxTokens: resolved?.maxOutput ?? bundledModel?.maxTokens } : {}),
          ...(m.supportsImageInput !== undefined
            ? { input: (m.supportsImageInput ? ['text', 'image'] : ['text']) as Array<'text' | 'image'> }
            : bundledModel?.input ? { input: [...bundledModel.input] } : {}),
          ...(m.reasoning !== undefined || m.reasoningEfforts !== undefined
            ? {
                reasoning: m.reasoning ?? (m.reasoningEfforts?.length ?? 0) > 0,
                ...(m.reasoningEfforts !== undefined
                  ? { thinkingLevelMap: { ...catalogThinkingLevelMap(m.reasoningEfforts, bundledModel?.thinkingLevelMap), ...(resolved?.reasoningRequired ? { off: null } : {}) } }
                  : {}),
              }
            : bundledModel
            ? {
                reasoning: bundledModel.reasoning,
                ...(bundledModel.reasoning && bundledModel.thinkingLevelMap
                  ? { thinkingLevelMap: { ...bundledModel.thinkingLevelMap } }
                  : {}),
              }
            : m.reasoning === true
              ? {
                  reasoning: true,
                  thinkingLevelMap: Object.fromEntries(
                    PI_REASONING_EFFORTS.map((effort) => [
                      effort,
                      supportedEfforts.has(effort) ? effort : null,
                    ]),
                  ),
                }
              : {}),
          ...(resolved?.cost ? { cost: catalogCostForPiNative(resolved.cost) }
            : bundledModel?.cost ? { cost: { ...bundledModel.cost } } : {}),
          ...(modelHeaders && Object.keys(modelHeaders).length > 0 ? { headers: modelHeaders } : {}),
          ...(bundledModel?.compat
            ? { compat: structuredClone(bundledModel.compat) }
            : !bundledModel && modelApi === 'openai-completions'
              ? // 未知自定义 Chat Completions 端点保守回落(#3832):火山引擎等
                // OpenAI 兼容网关只接受 system/assistant/user/tool,而 Pi 的
                // detectCompat 对陌生端点默认 supportsDeveloperRole=true,会把
                // system 指令按 role=developer 发出 → 整个模型不可用。system
                // role 在所有 OpenAI 兼容端点均可用,故无同源 bundled 元数据时
                // 默认收敛为 system;有 bundled 元数据的端点维持 Pi 原生判定。
                { compat: { supportsDeveloperRole: false } }
              : {}),
          ...(bundledModel?.samplingParams
            ? { samplingParams: structuredClone(bundledModel.samplingParams) }
            : {}),
        };
        return managedOllama && shouldApplyQwen38Overlay(m.id)
          ? applyQwen38NativeOverlay(spec)
          : spec;
      }),
    });
  }
  return { providers, env };
}
