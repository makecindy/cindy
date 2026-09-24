import { previousModelGenerations, generationCapabilities } from './modelGeneration.js';
import { alignModelApiRoute, providerInterfaceModelRoute, hasDeclaredProviderInterface, providerWireProtocolForApi, providerBaseUrlForApi } from './providerInterfaceRoutes.js';
import { nativeModelAgents } from './modelProtocol.js';
import { isMimoTokenPlanProvider } from './mimoPresentation.js';
import { resolveCatalogModelNativeApi, resolveModelNativeApi } from './modelRegistry.js';
import { providerEndpointBindings, bindProviderEndpoint, bindProviderPresetRuntime, canonicalProviderEndpoint } from './providerEndpointTemplate.js';
import { PI_MODEL_APIS } from "./types.js";
import { providerModelRecord, providerModelGenerationRecord, providerPresetModelRecord, providerModelMetadata } from "./providerModelCatalog.js";
import { BUNDLED_CATALOG, BUILTIN_PROVIDERS } from './builtin.js';
import { providerMediaField } from "./providerMediaModels.js";
import {
  expandedRegistryEntries,
  resolveModelMetadata,
  applyModelMetadata,
  mergeModelMetadata,
  pickModelMetadata,
  runtimeUserModelMetadata,
  findBaseModel,
  type ModelMetadata,
} from "./modelMetadataLayers.js";
import {
  piNativeCatalogModelDefaults,
  piNativeCatalogRouteMatches,
} from "./piNativeCatalog.js";
/**
 * 用户自定义供应商：把 `CustomProviderConfig` 展开成标准 `Provider`（纯逻辑，零依赖）。
 *
 * 设计要点：
 *   - 产出的 `Provider` 与内置厂商（providers.json）**同形状**，进同一 active-catalog，
 *     下游（路由 / 选择器 / listProviders）不区分内置 / 自定义，统一消费。
 *   - `source: 'user'`，鉴权可为 API key / OAuth / none。
 *   - 每个用户选中的 agent 生成一份与鉴权形态匹配的路由（upstream = baseUrl，带用户自定义
 *     headers）；**API key 不在此注入**——它存 safeStorage，由 host 在路由 resolve 时按
 *     `provider_key_<id>` 读出并写进鉴权头，绝不进 catalog（防经 listProviders 泄漏给 renderer）。
 *   - 用户模型可携带预设确认的 contextWindow；缺省时补保守默认，effort 使用 runtime 默认。
 */

import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  Effort,
  Provider,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
  RoutingDescriptor,
} from "./types.js";
import type { ModelRegistry } from "./modelAccessBean.js";
import { isLoopbackProviderUrl } from "./provider-url.js";
import {
  clampEffortToSupported,
  modelDefaultEffort,
  defaultEffortForCapabilities,
} from "./effortResolution.js";

/** 自定义模型缺省上下文窗口（用户不填元数据时的保守默认，仅用于展示）。 */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 200_000;

/**
 * Older releases allowed a user provider to occupy `xai`, which is now the built-in SuperGrok
 * source. Preserve the stored id, but project that legacy row under a collision-free runtime id.
 */
export const LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID = "custom:xai";
/** Official API-key preset for xAI; distinct from the built-in SuperGrok OAuth provider. */
export const XAI_API_CUSTOM_PROVIDER_ID = "xai-api";

export function runtimeCustomProviderId(providerId: string): string {
  return providerId === "xai"
    ? LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID
    : providerId;
}

export function storedCustomProviderId(providerId: string): string {
  return providerId === LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID
    ? "xai"
    : providerId;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function isOfficialXaiApiUpstream(upstream: string | undefined): boolean {
  try {
    const url = new URL(upstream ?? "");
    return (
      url.protocol === "https:" &&
      url.hostname === "api.x.ai" &&
      (url.pathname === "/v1" || url.pathname === "/v1/")
    );
  } catch {
    return false;
  }
}

/**
 * The chat-only xAI API preset uses the same public Imagine endpoints as the built-in
 * OAuth source. Project those catalog entries onto the API-key source only after the
 * official endpoint has been confirmed by the saved runtime routing.
 */
export function projectXaiApiImageModels(
  providers: readonly Provider[],
): readonly Provider[] {
  const xaiSource = providers.find((provider) => provider.id === "xai");
  if (
    !xaiSource?.imageModels?.length ||
    !providers.some((provider) => provider.id === XAI_API_CUSTOM_PROVIDER_ID)
  ) {
    return providers;
  }
  // 属性收窄无法跨越 map 回调边界，这里显式捕获非空清单。
  const sourceImageModels = xaiSource.imageModels;
  let changed = false;
  const projected = providers.map((provider) => {
    if (
      provider.id !== XAI_API_CUSTOM_PROVIDER_ID ||
      provider.source !== "user" ||
      provider.auth.method !== "apiKey" ||
      provider.imageModels?.length ||
      !Object.values(provider.routing).some((routing) =>
        isOfficialXaiApiUpstream(routing?.upstream),
      )
    ) {
      return provider;
    }
    changed = true;
    return { ...provider, imageModels: [...sourceImageModels] };
  });
  return changed ? projected : providers;
}

/**
 * Official-API image credentials may only come from runtimes whose saved routing
 * targets the official endpoint. Binding key reads to these agents prevents a
 * proxy-configured runtime's key from being disclosed to api.x.ai. Agents are
 * returned in fixed AGENT_ORDER so key selection stays deterministic when
 * several runtimes are official.
 */
export function xaiApiOfficialRuntimeAgents(
  provider: Provider | undefined,
): readonly AgentKind[] {
  if (!provider) return [];
  return AGENT_ORDER.filter((agent) =>
    isOfficialXaiApiUpstream(provider.routing[agent]?.upstream),
  );
}

interface RegistryEffortMetadata {
  efforts: Effort[];
  defaultEffort: Effort | null;
}

function toRegistryEffortMetadata(
  entry: {
    efforts?: readonly Effort[];
    defaultEffort?: Effort | null;
    perAgent?: Partial<
      Record<
        string,
        { efforts?: readonly Effort[]; defaultEffort?: Effort | null }
      >
    >;
  },
  agent: AgentKind,
): RegistryEffortMetadata | undefined {
  const perAgent = entry.perAgent?.[agent];
  const efforts = perAgent?.efforts ?? entry.efforts;
  if (!efforts) return undefined;
  const declaredDefault = modelDefaultEffort(entry);
  const defaultEffort =
    efforts.length === 0 || declaredDefault === null
      ? null
      : declaredDefault !== undefined
        ? (clampEffortToSupported(declaredDefault, efforts) as Effort)
        : defaultEffortForCapabilities(efforts);
  return { efforts: [...efforts], defaultEffort };
}

function consensusRegistryEffortMetadata(
  entries: readonly ModelRegistry["models"][number][],
  agent: AgentKind,
): RegistryEffortMetadata | undefined {
  const uniqueEntries = [
    ...new Map(entries.map((entry) => [entry.id, entry])).values(),
  ];
  const metadata = uniqueEntries.map((entry) =>
    toRegistryEffortMetadata(entry, agent),
  );
  const first = metadata[0];
  if (
    !first ||
    metadata.some(
      (value) =>
        !value ||
        value.defaultEffort !== first.defaultEffort ||
        value.efforts.length !== first.efforts.length ||
        value.efforts.some((effort, index) => effort !== first.efforts[index]),
    )
  ) {
    return undefined;
  }
  return first;
}

/**
 * 仅在模型能由当前 agent 的 Registry route 唯一识别，或所有匹配
 * 条目的 effort 元数据完全一致时复用该能力。
 * 自定义 provider 的 id、model id 与路由保持原值；Pi 能力继续只认逐模型显式配置。
 */
function registryEffortMetadata(
  registry: ModelRegistry | null | undefined,
  modelId: string,
  agent: AgentKind,
): RegistryEffortMetadata | undefined {
  if (agent === "pi" || !registry) return undefined;

  // Stage 1 — exact lookup: only the original modelId.
  const exactMatches = expandedRegistryEntries(registry).filter((entry) =>
    entry.routes.some(
      (route) =>
        route.agents.includes(agent) &&
        (entry.id === modelId || route.modelId === modelId),
    ),
  );
  if (exactMatches.length > 0) {
    return consensusRegistryEffortMetadata(exactMatches, agent);
  }

  // Stage 2 — prefix fallback: only when Stage 1 found nothing.
  // Strip common provider prefixes so third-party custom API models
  // (e.g. "openai/gpt-5.6-sol") can match registry entries whose
  // route.modelId is just "gpt-5.6-sol".
  const stripped = new Set<string>();
  for (const prefix of ["openai/", "xd/", "chatgpt/"]) {
    if (modelId.startsWith(prefix)) stripped.add(modelId.slice(prefix.length));
  }
  if (stripped.size === 0) return undefined;
  const fallbackMatches = expandedRegistryEntries(registry).filter((entry) =>
    entry.routes.some(
      (route) =>
        route.agents.includes(agent) &&
        (stripped.has(entry.id) || stripped.has(route.modelId)),
    ),
  );
  return consensusRegistryEffortMetadata(fallbackMatches, agent);
}

/**
 * Fast mode is a Codex service-tier capability, so a user provider may inherit it only when the
 * configured model id exactly matches a Registry route for Codex. Prefix fallback is intentionally
 * excluded: aliases can point at gateways with different billing or service-tier behavior.
 */
function registrySupportsFastMode(
  registry: ModelRegistry | null | undefined,
  modelId: string,
  agent: AgentKind,
): boolean {
  if (agent !== "codex" || !registry) return false;

  const matches = expandedRegistryEntries(registry).filter((entry) =>
    entry.routes.some(
      (route) => route.agents.includes(agent) && route.modelId === modelId,
    ),
  );
  return (
    matches.length > 0 &&
    matches.every(
      (entry) =>
        (entry.perAgent?.[agent]?.supportsFastMode ??
          entry.supportsFastMode) === true,
    )
  );
}

/** 固定 agent 顺序：保证派生出的 provider.agents / routing / models 顺序稳定。 */
const AGENT_ORDER: readonly AgentKind[] = ["claude-code", "codex", "pi"];

/** 单个用户填写的模型 → CatalogModel（只从已声明的能力补推理档位）。 */
function toCatalogModel(
  m: ProviderRuntimeModelConfig,
  providerId: string,
  agent: AgentKind,
  modelRegistry: ModelRegistry | null | undefined,
  providerDefaults?: ModelMetadata,
  metadataProviderId = providerId,
  generationDefaults?: ModelMetadata,
): CatalogModel {
  // 显式 runtime 能力优先：reasoning:true 才导出 efforts；false = 明确无思考档。
  // 新代际缺项可沿同系列/变体/协议继承；本型号目录、实报和用户配置优先。
  // 空档位只表示不指定推理强度，不代表要求供应商关闭思考。
  const efforts: Effort[] =
    m.reasoning === true
      ? [...(m.reasoningEfforts ?? [])]
      : [];
  const registryEfforts =
    m.reasoning !== undefined || (modelRegistry?.schemaVersion ?? 0) >= 4
      ? undefined
      : registryEffortMetadata(modelRegistry, m.id, agent);
  const supportsFastMode =
    (modelRegistry?.schemaVersion ?? 0) < 4 &&
    registrySupportsFastMode(modelRegistry, m.id, agent);
  const effectiveEfforts = registryEfforts?.efforts ?? efforts;
  const defaultEffort =
    registryEfforts !== undefined
      ? registryEfforts.defaultEffort
      : m.reasoning === true &&
          m.reasoningDefaultEffort &&
          effectiveEfforts.includes(m.reasoningDefaultEffort)
        ? m.reasoningDefaultEffort
        : defaultEffortForCapabilities(effectiveEfforts);
  const model: CatalogModel = {
    userModelConfig: { ...m },
    id: m.id,
    discoveredMetadata: m.discoveredMetadata,
    ...(m.discoveredCost ? { cost: m.discoveredCost } : {}),
    nameExplicit: m.nameExplicit,
    name: m.name,
    ...(agent === "pi" && m.piApi ? { piApi: m.piApi } : {}),
    ...(m.route ? { route: { ...m.route } } : {}),
    contextWindow: m.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
    // 用户自己填了才算显式声明;走 DEFAULT_CUSTOM_CONTEXT_WINDOW 兜底的不标记 ——
    // 那是「仅用于展示」的保守默认,不能拿去收敛运行期上报的窗口。
    ...(m.contextWindow !== undefined ? { contextWindowVerified: true } : {}),
    // 显式配置的窗口打标:编辑表单回转配置时必须与「缺省物化成的默认值」可区分,
    // 哪怕用户显式填的恰好等于当前默认(未来默认升级后显式值要原样保留)。
    ...(m.contextWindow !== undefined ? { contextWindowExplicit: true } : {}),
    efforts: effectiveEfforts,
    defaultEffort,
    // 选择器右栏按 group 聚合：同一自定义来源的模型聚成一组（渲染层用 provider 名兜底标签）。
    group: `custom:${providerId}`,
    // 手填模型保持历史默认可见；刷新发现的模型可显式声明默认隐藏。
    defaultEnabled: m.defaultEnabled ?? true,
    // 图片能力必须由用户/预设明确确认；缺省不猜，防止 Pi 静默把截图降级成占位文本。
    ...(m.supportsImageInput === true ? { supportsImageInput: true } : {}),
    ...(m.thinkingToggle === true ? { thinkingToggle: true } : {}),
    ...(supportsFastMode ? { supportsFastMode: true } : {}),
  };
  const user = runtimeUserModelMetadata(m);
  const resolved =
    (modelRegistry?.schemaVersion ?? 0) >= 4 ||
    m.discoveredMetadata ||
    providerDefaults || (generationDefaults && Object.keys(generationDefaults).length > 0)
      ? resolveModelMetadata(
          modelRegistry ?? undefined,
          metadataProviderId,
          m.id,
          m.discoveredMetadata,
          pickModelMetadata(user),
          agent,
          providerDefaults,
          undefined,
          generationDefaults,
        )
      : pickModelMetadata(user);
  return applyModelMetadata(model, resolved);
}

function defaultWireProtocol(agent: AgentKind): ProviderWireProtocol {
  // pi 默认 openai-chat:BYOM 本地端点(Ollama/vLLM 的 /v1/chat/completions)最常见。
  // 注:pi 走原生 provider 直连,routing.pi 不被 native 路径消费——此默认仅影响(未用的)
  // 路由描述符里是否显式记 wireProtocol,pi 实际 api 由 pi-host resolvePiNativeProviders 定。
  if (agent === "claude-code") return "anthropic-messages";
  if (agent === "pi") return "openai-chat";
  return "openai-responses";
}

/** baseUrl + 自定义 headers → 路由描述符（**不含密钥**）。 */
function toRouting(
  agent: AgentKind,
  baseUrl: string,
  requestPath: string | undefined,
  headers: Record<string, string> | undefined,
  headersState: "configured" | "unknown" | undefined,
  strategy: "api-key-header" | "oauth-token" | "oauth-passthrough" | "provider-oauth-header" | "none",
  modelsUrl?: string,
  wireProtocol?: ProviderWireProtocol,
  piCatalogProviderId?: string,
  supportsImageGeneration?: boolean,
): RoutingDescriptor {
  const r: RoutingDescriptor = {
    upstream: baseUrl,
    authStrategy: strategy,
    ...(agent === "codex" && strategy !== "oauth-passthrough" &&
    (wireProtocol ?? defaultWireProtocol(agent)) === "openai-responses"
      ? { supportsResponsesCustomTools: false }
      : {}),
    ...(agent === "codex" && supportsImageGeneration === true
      ? { supportsImageGeneration: true }
      : {}),
    ...(strategy === "none" &&
    (!isLoopbackProviderUrl(baseUrl) ||
      (modelsUrl !== undefined && !isLoopbackProviderUrl(modelsUrl)))
      ? { disabled: true }
      : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(wireProtocol &&
    (agent === "pi" || wireProtocol !== defaultWireProtocol(agent))
      ? { wireProtocol }
      : {}),
  };
  if (headers && Object.keys(headers).length > 0) {
    r.headerOverride = { ...headers };
    r.headerOverrideState = "configured";
  } else if (headersState === "unknown") {
    r.headerOverrideState = "unknown";
  }
  // 列模型端点回带（编辑表单从 routing 重建配置时不丢；路由器不消费本字段）。
  if (modelsUrl) r.modelsUrl = modelsUrl;
  if (piCatalogProviderId) r.piCatalogProviderId = piCatalogProviderId;
  return r;
}

/**
 * 把用户自定义配置展开成标准 `Provider`。纯函数，不校验（合法性由 host 的 store / handler 保证）。
 * 按 `runtimes` 里**已配置的 runtime** 生成各 agent 的 routing / models（每 runtime 独立 baseUrl /
 * 模型 / headers）；空 runtimes 产出空 Provider（不出现在任何 agent 列表，无害）。
 */
export interface BuildUserProviderOptions {
  modelRegistry?: ModelRegistry | null;
  presets?: readonly import("./types.js").ProviderPreset[];
}

export function buildUserProvider(
  config: CustomProviderConfig,
  options: BuildUserProviderOptions = {},
): Provider {
  const runtimeProviderId = runtimeCustomProviderId(config.id);
  // OAuth 形态路由走 Runner Bearer；none 明确走无鉴权且由 host 剥凭证；缺省保持历史 API key。
  const oauth = config.auth?.method === "oauth" ? config.auth.oauth : undefined;
  const nativeCodex = config.auth?.method === "oauth" && config.auth.native === "codex";
  const native = config.auth?.method === "oauth" ? config.auth.native : undefined;
  const isOAuth = oauth !== undefined || !!native;
  const noAuth = config.auth?.method === "none";
  const strategy = nativeCodex ? "oauth-passthrough" : native ? "provider-oauth-header" : isOAuth ? "oauth-token" : noAuth ? "none" : "api-key-header";
  const routing: Partial<Record<AgentKind, RoutingDescriptor>> = {};
  const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
  const agents: AgentKind[] = [];
  for (const agent of AGENT_ORDER) {
    const rt = config.runtimes[agent];
    if (!rt) continue;
    agents.push(agent);
    const preset = options.presets?.find(
      (preset) => preset.id === rt.catalogPresetId,
    );
    const presetRuntimeSource = preset?.runtimes[agent];
    const presetBindings = presetRuntimeSource
      ? providerEndpointBindings(presetRuntimeSource.baseUrl, rt.baseUrl) : null;
    const presetRuntime = presetRuntimeSource && presetBindings
      ? bindProviderPresetRuntime(presetRuntimeSource, rt.baseUrl) : presetRuntimeSource;
    const resolvedBaseUrl = presetBindings && presetRuntimeSource
      ? bindProviderEndpoint(presetRuntimeSource.baseUrl, presetBindings, rt.baseUrl)
      : rt.baseUrl;
    routing[agent] = toRouting(
      agent,
      resolvedBaseUrl,
      rt.requestPath,
      rt.headers,
      rt.headersState,
      strategy,
      presetRuntime?.modelsUrl ?? rt.modelsUrl,
      rt.wireProtocol,
      rt.piCatalogProviderId,
      rt.supportsImageGeneration,
    );
    const followsPreset =
      presetRuntime &&
      withoutTrailingSlashes(resolvedBaseUrl) ===
        withoutTrailingSlashes(presetRuntime.baseUrl) &&
      (rt.wireProtocol ?? defaultWireProtocol(agent)) ===
        (presetRuntime.wireProtocol ?? defaultWireProtocol(agent)) &&
      (rt.requestPath ?? "") === (presetRuntime.requestPath ?? "");
    // A bound single-API cloud connection keeps its language for new deployment IDs too.
    // This lends only the endpoint protocol, never another model's window or capabilities.
    const presetApis = new Set<ProviderRuntimeModelConfig['api']>(followsPreset ? presetRuntime.models.map(model => model.api ?? model.piApi) : []);
    const presetApi = presetApis.size === 1 ? [...presetApis][0] : undefined;
    const registrySources = [BUNDLED_CATALOG.modelRegistry, options.modelRegistry].filter(
      (source): source is ModelRegistry => source != null,
    );
    const publicGenerationCandidates = registrySources.flatMap(source =>
      (source.baseModels ?? []).flatMap(base => {
        const protocol = resolveCatalogModelNativeApi(source, base.id);
        return [base.id, ...base.aliases].map(id => ({ id, protocol, metadata: base.defaults }));
      }),
    );
    models[agent] = rt.models.map((storedModel) => {
      // Old ID-only imports must pick up newly known per-model interfaces too.
      // An explicit model API/path remains a user choice, not a preset default.
      const interfaceDefault = followsPreset && !storedModel.api && !storedModel.piApi && !storedModel.route
        ? presetRuntime.models.find(model => model.id === storedModel.id) : undefined;
      const configuredModel = interfaceDefault ? { ...storedModel,
        ...(interfaceDefault.api ? { api: interfaceDefault.api } : {}),
        ...(agent === 'pi' && interfaceDefault.piApi ? { piApi: interfaceDefault.piApi } : {}),
        ...(interfaceDefault.route ? { route: { ...interfaceDefault.route } } : {}),
      } : storedModel;
      const boundConfiguredModel = configuredModel.route
        ? { ...configuredModel, route: {
          ...configuredModel.route,
          baseUrl: canonicalProviderEndpoint(presetRuntimeSource?.baseUrl ?? '', configuredModel.route.baseUrl)
            ?? configuredModel.route.baseUrl,
        } }
        : configuredModel;
      const m = rt.requestPath ? boundConfiguredModel : alignModelApiRoute(
        providerInterfaceModelRoute(boundConfiguredModel, agent, rt.catalogPresetId, resolvedBaseUrl),
        resolvedBaseUrl, rt.wireProtocol ?? defaultWireProtocol(agent),
      );
      const presetModel = followsPreset
        ? presetRuntime.models.find((model) => model.id === m.id)
        : undefined;
      const sameRoute =
        m.route?.baseUrl === presetModel?.route?.baseUrl &&
        m.route?.wireProtocol === presetModel?.route?.wireProtocol &&
        m.route?.requestPath === presetModel?.route?.requestPath;
      const presetDefaults =
        presetModel && sameRoute
          ? mergeModelMetadata(presetModel.discoveredMetadata, pickModelMetadata({
              ...presetModel,
              efforts:
                presetModel.reasoning === false
                  ? []
                  : presetModel.reasoningEfforts,
              defaultEffort: presetModel.reasoningDefaultEffort,
            }))
          : undefined;
      // Pi 来源带 piCatalogProviderId 且仍走官方路由时,pi-host 运行期会整条套用官方 Pi
      // 目录;没有 catalogPresetId(#4108 之前创建)的存量来源在这里没有预设默认,存储
      // 模型又缺 reasoning 字段,目录投影就成了空档位,Orca 创建 Worker 时把合法的
      // max 拒成「valid: none」(#4295)。按同一份官方目录补默认:预设按字段覆盖官方
      // 目录(预设只声明 context/image 时 reasoning 仍由目录补),用户显式配置仍优先。
      const catalogDefaults =
        agent === "pi" && rt.piCatalogProviderId && !m.route &&
        piNativeCatalogRouteMatches(rt.piCatalogProviderId, resolvedBaseUrl, rt.wireProtocol)
          ? piNativeCatalogModelDefaults(rt.piCatalogProviderId, m.id)
          : undefined;
      const wire = m.route?.wireProtocol ?? rt.wireProtocol ?? defaultWireProtocol(agent);
      // Pi's model API overrides the runtime default. Match that actual API, rather than
      // discarding all metadata when a Responses/Gemini model shares a Chat connection.
      // With no explicit model route/API, an exact endpoint + unique ID supplies Pi's API.
      const imported = !(m.route?.requestPath ?? rt.requestPath)
        ? providerModelRecord(m.id, m.route?.baseUrl ?? resolvedBaseUrl,
            m.api ?? (agent === 'pi' ? m.piApi ?? wire : wire),
            !m.api && !m.piApi && !m.route)
          ?? (hasDeclaredProviderInterface(m, agent, rt.catalogPresetId, resolvedBaseUrl)
            ? providerPresetModelRecord(rt.catalogPresetId, m.id) : undefined)
          ?? (followsPreset && sameRoute && m.api && presetModel?.api === m.api
            ? providerPresetModelRecord(preset?.id, m.id, m.api) : undefined)
          ?? providerModelGenerationRecord(m.id, m.route?.baseUrl ?? resolvedBaseUrl, m.api ?? m.piApi ?? wire, followsPreset ? preset?.id : undefined)
        : undefined;
      // Existing catalog identities keep their established execution path. A
      // predecessor supplies parameters, not permission to switch their adapter.
      const keepExistingApi = imported?.inheritedFrom && registrySources.some(source => findBaseModel(source, m.id));
      const importedApi = imported && !keepExistingApi &&
        PI_MODEL_APIS.some(api => api === imported.execution.pi.api)
          ? imported.execution.pi.api as NonNullable<ProviderRuntimeModelConfig['piApi']>
          : !m.route && presetApi ? presetApi
          : wire === 'google-generative-ai' ? 'google-generative-ai' : undefined;
      // Recompute inherited defaults from declarations, never save them as user edits.
      // Same-connection declarations win within a generation; public defaults fill gaps.
      const protocol = m.api ?? m.piApi ?? (wire === 'openai-chat' ? 'openai-completions' : wire);
      const generationCandidates: Array<{ id: string; metadata: ModelMetadata }> =
        publicGenerationCandidates.filter(candidate => candidate.protocol === protocol);
      if (imported?.inheritedFrom) generationCandidates.push({
        id: imported.inheritedFrom, metadata: providerModelMetadata(imported),
      });
      for (const candidate of previousModelGenerations(m.id, [...(followsPreset ? presetRuntime.models : []), ...rt.models], candidate => candidate.id)) {
        const candidateWire = candidate.route?.wireProtocol ?? rt.wireProtocol ?? defaultWireProtocol(agent);
        const candidateProtocol = candidate.api ?? candidate.piApi ??
          (candidateWire === 'openai-chat' ? 'openai-completions' : candidateWire);
        if (candidateProtocol !== protocol ||
            withoutTrailingSlashes(candidate.route?.baseUrl ?? resolvedBaseUrl) !== withoutTrailingSlashes(m.route?.baseUrl ?? resolvedBaseUrl) ||
            (candidate.route?.requestPath ?? rt.requestPath) !== (m.route?.requestPath ?? rt.requestPath)) continue;
        const candidateRow = providerModelRecord(candidate.id, candidate.route?.baseUrl ?? resolvedBaseUrl, candidateProtocol);
        generationCandidates.push({ id: candidate.id, metadata: mergeModelMetadata(
          ...registrySources.map(source => findBaseModel(source, candidate.id)?.defaults),
          candidateRow ? providerModelMetadata(candidateRow) : undefined,
          candidate.discoveredMetadata,
          runtimeUserModelMetadata(candidate),
        ) });
      }
      const generationDefaults = mergeModelMetadata(
        ...previousModelGenerations(m.id, generationCandidates, candidate => candidate.id)
          .map(candidate => generationCapabilities(candidate.metadata)),
      );
      const defaults = imported || catalogDefaults || presetDefaults
        ? mergeModelMetadata(imported && !imported.inheritedFrom ? providerModelMetadata(imported) : undefined, catalogDefaults, presetDefaults)
        : undefined;
      // A verified catalog identity can reuse the manufacturer's declaration.
      // Execution protocols and prices still belong to this exact connection.
      const registry = options.modelRegistry ?? undefined;
      const resolveDeclaration = (source: ModelRegistry | undefined) => {
        const baseModel = findBaseModel(source, m.id);
        const routeNativeApi = resolveModelNativeApi(source, config.id, m.id);
        return routeNativeApi !== undefined ? routeNativeApi
          : resolveCatalogModelNativeApi(source, baseModel?.id ?? m.id);
      };
      const projected = toCatalogModel(
        m,
        followsPreset && sameRoute ? preset!.id : config.id,
        agent,
        options.modelRegistry,
        defaults,
        nativeCodex ? 'openai' : undefined,
        generationDefaults,
      );
      const currentDeclaration = resolveDeclaration(registry);
      // Apply current Server identity after capability projection, including an
      // explicit unknown. Only absent declarations may use discovery/local fallback.
      const declaration = currentDeclaration !== undefined ? currentDeclaration
        : projected.nativeApi !== undefined ? projected.nativeApi
        : resolveDeclaration(BUNDLED_CATALOG.modelRegistry);
      const nativeApi = declaration === null || declaration === 'anthropic-messages'
        || declaration === 'openai-responses' || declaration === 'openai-completions'
        || declaration === 'google-generative-ai' ? declaration : undefined;
      return {
        ...(imported?.cost ? { cost: imported.cost } : {}),
        ...projected,
        ...(nativeApi !== undefined ? { nativeApi } : {}),
        // Projection is not a user edit. Save only the original configuration.
        userModelConfig: structuredClone(storedModel),
        ...(m.api ? { api: m.api, ...(agent === 'pi' ? { piApi: m.api } : {}) } : {}),
        ...(importedApi && !m.piApi && !m.api ? {
          api: importedApi, ...(agent === 'pi' ? { piApi: importedApi } : {}),
          ...(!m.route && providerWireProtocolForApi(importedApi) && providerWireProtocolForApi(importedApi) !== wire ? { route: {
            baseUrl: providerBaseUrlForApi(resolvedBaseUrl, importedApi),
            wireProtocol: providerWireProtocolForApi(importedApi)!,
          } } : {}),
        } : {}),
        ...(rt.catalogPresetId ? { catalogPresetId: rt.catalogPresetId } : {}),
      };
    });
  }
  if (native === 'claude' || native === 'xai') {
    const identity = BUILTIN_PROVIDERS.find((provider) => provider.id === (native === 'claude' ? 'anthropic' : 'xai'))!;
    return {
      ...identity,
      id: runtimeProviderId,
      name: config.name,
      source: 'user',
      // 独立 Claude 账号已停用:它的凭证由 Cindy 自己登录并保存,而 Claude 订阅只允许经
      // 官方 CLI 自己的登录使用。条目保留在设置里供用户查看 / 删除,不再提供给任何 agent。
      ...(native === 'claude' ? { agents: [] } : {}),
      auth: { method: 'oauth', native },
      routing: Object.fromEntries(Object.entries(identity.routing).map(([agent, route]) => [
        agent, {
          ...route,
          authStrategy: 'provider-oauth-header',
          // Claude subscription requests must not carry a CLI placeholder API key alongside OAuth.
          ...(native === 'claude' && agent === 'claude-code'
            ? { headerDelete: [...new Set([...(route.headerDelete ?? []), 'x-api-key'])] }
            : {}),
        },
      ])),
      // Media remains explicitly bound to the original provider until it supports account selection.
      imageModels: undefined,
      imageDefaults: undefined,
      videoModels: undefined,
      videoDefaults: undefined,
    };
  }
  if (nativeCodex) {
    const identity = BUILTIN_PROVIDERS.find((provider) => provider.id === 'openai')!;
    return {
      ...identity,
      id: runtimeProviderId,
      name: config.name,
      source: 'user',
      auth: { method: 'oauth', native: 'codex' },
      models: { ...identity.models, codex: models.codex ?? [] },
      // The active catalog binds the current public image definition to each connection.
      // Do not freeze bundled membership when an independent account is constructed.
      imageModels: undefined,
      imageDefaults: undefined,
    };
  }
  // Selection/import membership does not opt the user into compatibility harnesses.
  // Keep explicit configuration defaults; visibility preferences remain a separate override.
  for (const agent of agents) for (const model of models[agent] ?? []) {
    if (!providerMediaField(model.mode) && model.userModelConfig?.defaultEnabled === undefined) {
      model.defaultEnabled = nativeModelAgents({ id: config.id, routing, source: 'user' }, { [agent]: model }).includes(agent);
    }
  }
  const mediaLists: Partial<
    Pick<
      Provider,
      "imageModels" | "videoModels" | "audioModels" | "embeddingModels"
    >
  > = {};
  for (const [agent, list] of Object.entries(models)) {
    for (const model of list ?? []) {
      const field = providerMediaField(model.mode);
      if (!field) continue;
      const items = (mediaLists[field] ??= []);
      if (!items.some((item) => item.id === model.id))
        items.push({
          ...pickModelMetadata(model),
          id: model.id,
          name: model.name,
          mode: model.mode,
          discoveredMetadata: model.discoveredMetadata,
          sourceAgent: agent as AgentKind,
          ...(model.modalities ? { modalities: model.modalities } : {}),
          ...(model.description ? { description: model.description } : {}),
        });
    }
  }
  return {
    ...mediaLists,
    id: runtimeProviderId,
    name: config.name,
    source: "user",
    agents,
    auth: isOAuth
      ? { method: "oauth", ...(nativeCodex ? { native: "codex" as const } : { oauth }) }
      : noAuth
        ? { method: "none" }
        : { method: "apiKey" },
    // Authentication and billing are independent: MiMo Token Plan uses an API key.
    ...(isOAuth ? {} : {
      access: !noAuth && isMimoTokenPlanProvider({ routing, models })
        ? { kind: 'subscription' as const, product: 'MiMo Token Plan' }
        : { kind: 'api' as const },
    }),
    routing,
    models,
  };
}
