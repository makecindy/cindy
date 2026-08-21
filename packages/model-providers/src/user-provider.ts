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

/** 自定义模型缺省上下文窗口（用户不填元数据时的保守默认，仅用于展示）。 */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 200_000;

/**
 * Older releases allowed a user provider to occupy `xai`, which is now the built-in SuperGrok
 * source. Preserve the stored id, but project that legacy row under a collision-free runtime id.
 */
export const LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID = "custom:xai";

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

/**
 * 自定义模型的默认 effort 档位（「参考默认设置」）——与内置当代旗舰模型对齐：
 *   - claude-code：low/medium/high/xhigh/max（同 opus / fable）；
 *   - codex：low/medium/high/xhigh/max（gpt-5.x 同款五档，ultra 仍仅限已登记模型）。
 * 让自定义模型像内置模型一样能在选择器里切 reasoning/thinking 强度（默认 high）。
 * 端点是否真支持由其后端决定：cc 经 `thinking`、codex 经 reasoning effort 透传，
 * anthropic-compat-proxy 仅对个别内置 model id strip 字段、对自定义 id 一律字节透传。
 * 未登记模型（Registry 无法确认能力）也放开到 max：第三方 Responses 兼容端点普遍
 * 接受与否只有端点方/用户知道，选到不支持的档位会被上游拒绝，用户改选即可；
 * 默认档保持 high，存量行为不变（见 #2964）。
 */
const CUSTOM_EFFORTS: Partial<Record<AgentKind, Effort[]>> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
};
/** 自定义模型默认选中的 effort（与内置旗舰一致）。 */
const DEFAULT_CUSTOM_EFFORT: Effort = "high";

interface RegistryEffortMetadata {
  efforts: Effort[];
  defaultEffort: Effort | null;
}

/**
 * 仅在模型能由当前 agent 的 Registry route 唯一识别时复用 effort 元数据。
 * 自定义 provider 的 id、model id 与路由保持原值；Pi 能力继续只认逐模型显式配置。
 */
function registryEffortMetadata(
  registry: ModelRegistry | null | undefined,
  modelId: string,
  agent: AgentKind,
): RegistryEffortMetadata | undefined {
  if (agent === "pi" || !registry) return undefined;

  const candidates = new Set([modelId]);
  if (modelId.startsWith("chatgpt/")) {
    candidates.add(modelId.slice("chatgpt/".length));
  }
  const matches = registry.models.filter((entry) =>
    entry.routes.some(
      (route) =>
        route.agents.includes(agent) &&
        (candidates.has(entry.id) || candidates.has(route.modelId)),
    ),
  );
  const uniqueEntries = [
    ...new Map(matches.map((entry) => [entry.id, entry])).values(),
  ];
  if (uniqueEntries.length !== 1) return undefined;

  const entry = uniqueEntries[0]!;
  const perAgent = entry.perAgent?.[agent];
  const efforts = perAgent?.efforts ?? entry.efforts;
  if (!efforts) return undefined;
  const declaredDefault = perAgent?.defaultEffort ?? entry.defaultEffort;
  const defaultEffort =
    declaredDefault && efforts.includes(declaredDefault)
      ? declaredDefault
      : efforts.includes(DEFAULT_CUSTOM_EFFORT)
        ? DEFAULT_CUSTOM_EFFORT
        : (efforts[efforts.length - 1] ?? null);
  return { efforts: [...efforts], defaultEffort };
}

/** 固定 agent 顺序：保证派生出的 provider.agents / routing / models 顺序稳定。 */
const AGENT_ORDER: readonly AgentKind[] = ["claude-code", "codex", "pi"];

/** 单个用户填写的模型 → CatalogModel（补默认元数据；effort 按所属 agent 参考内置默认）。 */
function toCatalogModel(
  m: ProviderRuntimeModelConfig,
  providerId: string,
  agent: AgentKind,
  modelRegistry: ModelRegistry | null | undefined,
): CatalogModel {
  // 显式 runtime 能力优先：reasoning:true 才导出 efforts；false = 明确无思考档。
  // 字段缺省才走历史 fallback（Pi 空档 / 其它自定义 Provider 的 CUSTOM_EFFORTS）。
  const efforts: Effort[] =
    m.reasoning === true
      ? [...(m.reasoningEfforts ?? [])]
      : m.reasoning === false
        ? []
        : agent === "pi"
          ? []
          : (CUSTOM_EFFORTS[agent] ?? []);
  const registryEfforts =
    m.reasoning !== undefined
      ? undefined
      : registryEffortMetadata(modelRegistry, m.id, agent);
  const effectiveEfforts = registryEfforts?.efforts ?? efforts;
  const defaultEffort =
    registryEfforts?.defaultEffort ??
    (m.reasoning === true &&
    m.reasoningDefaultEffort &&
    effectiveEfforts.includes(m.reasoningDefaultEffort)
      ? m.reasoningDefaultEffort
      : effectiveEfforts.includes(DEFAULT_CUSTOM_EFFORT)
        ? DEFAULT_CUSTOM_EFFORT
        : (effectiveEfforts[0] ?? null));
  return {
    id: m.id,
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
  };
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
  strategy: "api-key-header" | "oauth-token" | "none",
  modelsUrl?: string,
  wireProtocol?: "anthropic-messages" | "openai-responses" | "openai-chat",
  piCatalogProviderId?: string,
): RoutingDescriptor {
  const r: RoutingDescriptor = {
    upstream: baseUrl,
    authStrategy: strategy,
    ...(strategy === "none" &&
    (!isLoopbackProviderUrl(baseUrl) ||
      (modelsUrl !== undefined && !isLoopbackProviderUrl(modelsUrl)))
      ? { disabled: true }
      : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(wireProtocol && (agent === 'pi' || wireProtocol !== defaultWireProtocol(agent))
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
}

export function buildUserProvider(
  config: CustomProviderConfig,
  options: BuildUserProviderOptions = {},
): Provider {
  const runtimeProviderId = runtimeCustomProviderId(config.id);
  // OAuth 形态路由走 Runner Bearer；none 明确走无鉴权且由 host 剥凭证；缺省保持历史 API key。
  const oauth = config.auth?.method === "oauth" ? config.auth.oauth : undefined;
  const isOAuth = oauth !== undefined;
  const noAuth = config.auth?.method === "none";
  const strategy = isOAuth ? "oauth-token" : noAuth ? "none" : "api-key-header";
  const routing: Partial<Record<AgentKind, RoutingDescriptor>> = {};
  const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
  const agents: AgentKind[] = [];
  for (const agent of AGENT_ORDER) {
    const rt = config.runtimes[agent];
    if (!rt) continue;
    agents.push(agent);
    routing[agent] = toRouting(
      agent,
      rt.baseUrl,
      rt.requestPath,
      rt.headers,
      rt.headersState,
      strategy,
      rt.modelsUrl,
      rt.wireProtocol,
      rt.piCatalogProviderId,
    );
    models[agent] = rt.models.map((m) =>
      toCatalogModel(m, config.id, agent, options.modelRegistry),
    );
  }
  return {
    id: runtimeProviderId,
    name: config.name,
    source: "user",
    agents,
    auth: isOAuth
      ? { method: "oauth", oauth }
      : noAuth
        ? { method: "none" }
        : { method: "apiKey" },
    // API key / 无鉴权代理都属于用户自备接口；通用 OAuth 可能订阅也可能按量，未声明前不猜。
    ...(isOAuth ? {} : { access: { kind: "api" as const } }),
    routing,
    models,
  };
}
