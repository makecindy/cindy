/**
 * 供应商登记表（registry）—— 纯逻辑：合并连接状态、按 agent 算可见性、解析路由素材。
 *
 * 连接状态由 host 注入（XD: api_key 是否存在 / Anthropic: 是否有 claude.ai OAuth /
 * OpenAI: codex 是否 OAuth 登录），本模块不读任何存储。
 *
 * SSoT：**目录就是 per-agent 模型清单的唯一来源**。模型按 agent 分组挂在
 * `Provider.models[agent]` 下；host 从目录派生 maker-core 的 per-agent availableModels
 * （不再有写死的 CLAUDE_MODELS / CODEX_MODELS）。因此本模块的查询都带 `agent` 维度：
 *   - 哪些供应商支持某 agent（来源栏可见性）
 *   - 某 (model, agent) 由哪些供应商提供（source 选择）
 *   - 解析 (provider, model, agent) → 路由素材（供 host 通用路由器落地）
 */

import type { Catalog, Provider, CatalogModel, AgentKind, RoutingDescriptor } from './types.js';
import type { ProviderLogoKind } from './providerBranding.js';

/** 各供应商是否已连接，由 host 注入。 */
export type ConnectionState = Record<string, boolean>;

/**
 * 动态清单发现的失败归因。
 *
 * 只有「清单唯一来源是动态发现」的供应商才会有（如 Anthropic 订阅：静态目录段已退役，
 * 拉不到 `/v1/models` 就是零模型）。这类供应商一旦发现失败，UI 若继续说「已连接，正在
 * 发现模型」就是在骗用户——直连不通的网络环境下它永远不会自己好转。`kind` 决定 UI 说
 * 什么，`detail` 只进日志与诊断，不直接展示（可能含上游原始错误文本）。
 */
export interface ProviderModelDiscoveryFailure {
  /**
   * 归因分两类，决定 host 该不该自动重试（判定在 host 侧，见各供应商的 discovery 实现）：
   *
   * **可能是暂时的 —— 值得重试**
   *   network  —— 连不上（DNS 失败 / 连接被拒 / 链路不通）
   *   timeout  —— 连上了但超时
   *   upstream —— 上游 5xx / 429 等服务端侧故障
   *
   * **确定性拒绝 —— 重试没有意义，只会把「被拒绝」拖成「一直在发现中」**
   *   regionBlocked —— 供应商不向当前所在地区提供服务（Anthropic 的
   *                    `unsupported_country_region_territory`，400 / 403 都出现过，
   *                    必须读响应体判定而不是只看状态码）
   *   unauthorized  —— 凭证被拒（401）
   *   forbidden     —— 请求被拒但不是地域原因（如 Cloudflare 对代理 / VPN 出口的拦截）
   *   rejected      —— 其它 4xx
   *   empty         —— 正常答复但没有任何可用模型
   */
  kind:
    | 'network'
    | 'timeout'
    | 'upstream'
    | 'regionBlocked'
    | 'unauthorized'
    | 'forbidden'
    | 'rejected'
    | 'empty';
  /**
   * 诊断用原文（上游响应体片段、errno、异常消息等），**只留在 Main 侧的日志与内存**。
   * 绝不下发：见 ProviderModelDiscoveryFailureView。
   */
  detail?: string;
  /** ISO 时间戳，用于展示「最近一次尝试」。 */
  at: string;
}

/**
 * 跨进程 / device-link 下发的失败投影 —— 刻意剥掉 `detail`。
 *
 * `ProviderView` 会经 `maker:provider:list` 到达 renderer，并由 device-link 投影给配对的
 * 控制端；而 `detail` 里可能是最多 2KB 的上游原始响应体（代理错误页、请求元数据等）。
 * UI 只按 `kind` 渲染分类文案，没有任何理由把这些原文送出 Main。
 */
export type ProviderModelDiscoveryFailureView = Omit<ProviderModelDiscoveryFailure, 'detail'>;

/**
 * 各供应商最近一次的清单发现失败，由 host 注入；成功即清除。
 *
 * 稀疏 map：只有「清单唯一来源是动态发现」且当前确实失败了的供应商才有键，缺省是 `{}`。
 * 因此必须是 `Partial` —— 写成全量 `Record` 会让 `state[id]` 的类型谎称不可能是
 * `undefined`，读 `.kind` 的调用方迟早在运行时炸。
 */
export type ModelDiscoveryFailureState = Partial<
  Record<string, ProviderModelDiscoveryFailure | null>
>;

/** 供应商 + 连接状态。 */
export interface ProviderView extends Provider {
  connected: boolean;
  /** Non-secret presentation metadata resolved before routing details cross device-link. */
  logoKind?: ProviderLogoKind;
  /** 动态清单发现的最近一次失败（已剥掉 detail）；成功或从未失败时缺席。 */
  modelDiscoveryFailure?: ProviderModelDiscoveryFailureView;
}

/**
 * 失败态 → 可下发投影：显式丢弃 `detail`。
 *
 * 用解构而不是 `{ kind, at }` 手抄字段：将来给 failure 加新字段时，默认行为是「跟着下发」
 * 而不是「被静默丢掉」，只有明确判定为敏感的才需要在这里追加剥离。
 */
function stripDiscoveryFailureDetail(
  failure: ProviderModelDiscoveryFailure,
): ProviderModelDiscoveryFailureView {
  const { detail: _detail, ...view } = failure;
  return view;
}

/** 把目录与连接状态合成 registry。 */
export function buildRegistry(
  catalog: Catalog,
  connected: ConnectionState,
  discoveryFailures: ModelDiscoveryFailureState = {},
): ProviderView[] {
  return catalog.providers.map((p) => {
    const failure = discoveryFailures[p.id];
    // 剥掉 detail 再下发:它可能是上游原始响应体,而这份视图会过 IPC 到 renderer、
    // 再经 device-link 投影给配对控制端。UI 只用 kind。
    const failureView = failure ? stripDiscoveryFailureDetail(failure) : null;
    return {
      ...p,
      connected: connected[p.id] ?? false,
      ...(failureView ? { modelDiscoveryFailure: failureView } : {}),
    };
  });
}

/** 该供应商的指定 runtime 是否可参与选择 / 路由。 */
function hasEnabledAgentRuntime(provider: Provider, agent: AgentKind): boolean {
  const routing = provider.routing?.[agent];
  return provider.agents.includes(agent) && routing !== undefined && routing.disabled !== true;
}

/** 该 agent 兼容的所有供应商（不论连接与否）—— 供应商页「可用」列表用。 */
export function providersForAgent(views: ProviderView[], agent: AgentKind): ProviderView[] {
  return views.filter((p) => hasEnabledAgentRuntime(p, agent));
}

/** 该 agent 已连接的供应商 —— 模型选择器「来源栏」用。 */
export function connectedProvidersForAgent(views: ProviderView[], agent: AgentKind): ProviderView[] {
  return views.filter((p) => p.connected && hasEnabledAgentRuntime(p, agent));
}

/** 该供应商是否在某 agent 下提供某 model id。 */
export function providerOffersModel(provider: Provider, modelId: string, agent: AgentKind): boolean {
  return (provider.models[agent] ?? []).some((m) => m.id === modelId);
}

/** 取某供应商在某 agent 下的模型元数据（找不到返回 undefined）。 */
export function getModel(
  provider: Provider,
  modelId: string,
  agent: AgentKind,
): CatalogModel | undefined {
  return (provider.models[agent] ?? []).find((m) => m.id === modelId);
}

/**
 * 某个模型在某 agent 会话下的「可选来源」：支持该 agent 且提供该模型的供应商。
 * `onlyConnected` 默认 true（选择器场景）；false 则含未连接（用于"去连接"引导）。
 * 注意：调用方应只对"对该 agent 有效"的模型（来自 maker-core availableModels）查询。
 */
export function sourcesForModel(
  views: ProviderView[],
  modelId: string,
  agent: AgentKind,
  opts: { onlyConnected?: boolean } = {},
): ProviderView[] {
  const onlyConnected = opts.onlyConnected ?? true;
  return views.filter(
    (p) =>
      (!onlyConnected || p.connected) &&
      hasEnabledAgentRuntime(p, agent) &&
      providerOffersModel(p, modelId, agent),
  );
}

/**
 * 某 agent 在已连接来源列表(rail)里的「原生默认来源 id」。
 * 与模型选择器 activeSourceId 的 nativeDefault 口径一致:
 *   codex  → 优先 openai,其次 xd,再兜底 rail 首项。
 *   cc + 其余 → 优先 xd,兜底 rail 首项。
 * rail 为空(零已连接来源)→ null。
 */
export function nativeDefaultSourceId(rail: ProviderView[], agent: AgentKind | null): string | null {
  if (rail.length === 0) return null;
  const has = (id: string) => rail.some((p) => p.id === id);
  if (agent === 'codex') return has('openai') ? 'openai' : has('xd') ? 'xd' : rail[0].id;
  return has('xd') ? 'xd' : rail[0].id;
}

/**
 * 解析某个会话当前 `(agent, model)` 真正可用的来源 id。
 *
 * 来源选择必须先收窄到「已连接且确实提供当前模型」的集合，再应用显式选择 / 原生默认：
 * 否则当 XD key 被清除、但 OpenAI 仍连接时，Claude 会话会把 OpenAI 当成 agent 级兜底，
 * 拼出「OpenAI 图标 + Opus」这种不可能路由。显式来源失效时返回同模型的默认可用来源；
 * 当前模型没有任何已连接来源时返回 null。
 */
export function effectiveSourceIdForModel(
  views: ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  agent: AgentKind,
): string | null {
  const sources = sourcesForModel(views, modelId, agent);
  if (providerId && sources.some((provider) => provider.id === providerId)) return providerId;
  return nativeDefaultSourceId(sources, agent);
}

/**
 * 某 (provider, model, agent) 是否支持 Fast 模式 —— 纯函数,**Fast 能力的唯一真相**。
 * 直接读该供应商在该 agent 下那个模型条目的 `supportsFastMode`（per-provider，见 CatalogModel）。
 * 缺省 / 取不到 provider / 该来源不提供此模型 ⇒ false（不显示开关）。
 *
 * 实际可用 = `agent.hasFastMode && modelSupportsFastMode(...)`（agent 粗粒度 gate 由调用方叠加）。
 * 注意：必须传入**具体某个 provider**的条目，不能用跨 provider 拍平去重后的模型（那只保留首个
 * 供应商的值，遇到 per-provider 分叉会错）。
 */
export function modelSupportsFastMode(
  provider: ProviderView | Provider | undefined,
  modelId: string,
  agent: AgentKind,
): boolean {
  if (!provider) return false;
  return !!getModel(provider, modelId, agent)?.supportsFastMode;
}

/**
 * 会话维度的 Fast 门控:解析「当前生效来源」后,查该来源下这个模型的 `supportsFastMode`。
 * 生效来源口径与模型选择器 activeSourceId 一致(显式 providerId 若已连接则用它,否则取该 agent 的
 * nativeDefaultSourceId)。这样 providerId 为 null(未显式选源)时也能命中真实默认来源
 * —— 例如 cc 默认源是 xd 网关(见 nativeDefaultSourceId),若该来源把某模型 fast 配为 false
 * ⇒ 默认不显示,只有用户显式选到 fast 可用的来源(如官方 Anthropic)才显示。
 */
export function sessionModelSupportsFastMode(
  views: ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  agent: AgentKind,
): boolean {
  const sourceId = effectiveSourceIdForModel(views, providerId, modelId, agent);
  const effective = sourceId ? views.find((provider) => provider.id === sourceId) : undefined;
  return modelSupportsFastMode(effective, modelId, agent);
}

/** 路由解析结果（喂给 host 通用路由器）。 */
export interface ResolvedRoute {
  provider: ProviderView;
  model: CatalogModel;
  routing: RoutingDescriptor;
}

/**
 * 解析 `{providerId, modelId, agent}` → 路由素材。
 * 校验：provider 存在、该 agent ∈ provider.agents、provider 提供该 model、且声明了
 * 该 agent 的 routing。任一不满足返回 null（调用方走兜底 / 报错）。
 */
export function resolveRoute(
  views: ProviderView[],
  providerId: string,
  modelId: string,
  agent: AgentKind,
): ResolvedRoute | null {
  const provider = views.find((p) => p.id === providerId);
  if (!provider) return null;
  if (!provider.agents.includes(agent)) return null;
  const model = getModel(provider, modelId, agent);
  if (!model) return null;
  const routing = provider.routing[agent];
  if (!routing || routing.disabled) return null;
  return { provider, model, routing };
}
