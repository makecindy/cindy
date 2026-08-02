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
import {
  isAgentSelectableModel,
  isModelSelectableForNewRoute,
} from './classification.js';
import type { ProviderLogoKind } from './providerBranding.js';
import {
  isModelDisabled,
  isProviderDisabled,
  type ModelDisableOverrides,
} from './disableOverrides.js';

/** 各供应商是否已连接，由 host 注入。 */
export type ConnectionState = Record<string, boolean>;

/**
 * 动态清单发现的失败归因。
 *
 * 只有 live entitlement 证据依赖动态发现的供应商才会有（如 Anthropic 订阅）。
 * Registry presence 可能仍让目录展示模型，但发现失败意味着当前账号尚未得到可用性
 * 证明；UI 若继续说「已连接，正在发现模型」就是在骗用户。`kind` 决定 UI 说什么，
 * `detail` 只进日志与诊断，不直接展示（可能含上游原始错误文本）。
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
 * 稀疏 map：只有 live entitlement 证据依赖动态发现且当前确实失败的供应商才有键，
 * 缺省是 `{}`。
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
  /**
   * 用户把该供应商整体「停用」(凭证保留;见 disableOverrides.ts)。`connected` 保持真实
   * 连接态(设置页要如实展示凭证状态),但 `connectedProvidersForAgent` /
   * `sourcesForModel` 会把 suspended 供应商从一切可路由集合里剔除 —— 对所有
   * 选择器 / 路由 / IM / device-link 消费方,停用 ≙ 不可用。
   */
  suspended?: boolean;
  /**
   * 该供应商名下的停用 override 总数(供应商级标志 + 全部逐模型条目)。与烘进模型
   * 条目的 `disabled` 标志不同,它**包含指向已下架模型的陈旧条目**。设置页据此在
   * 「目录里已无对应行」时仍展示组级「全部启用」恢复入口(configuration-and-
   * overrides.md §4;PR #744 review 第二十六轮)。0 时缺席(纯附加字段,老端忽略)。
   */
  disableOverrideCount?: number;
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

/** 把目录与连接状态合成 registry。`access` = 用户的停用 override(见 disableOverrides.ts)。 */
export function buildRegistry(
  catalog: Catalog,
  connected: ConnectionState,
  discoveryFailures: ModelDiscoveryFailureState = {},
  access?: ModelDisableOverrides,
): ProviderView[] {
  const disabledKeys = access?.disabledModels ? Object.keys(access.disabledModels) : [];
  return catalog.providers.map((p) => {
    const failure = discoveryFailures[p.id];
    // 剥掉 detail 再下发:它可能是上游原始响应体,而这份视图会过 IPC 到 renderer、
    // 再经 device-link 投影给配对控制端。UI 只用 kind。
    const failureView = failure ? stripDiscoveryFailureDetail(failure) : null;
    const suspended = isProviderDisabled(access, p.id);
    // 该供应商名下的停用 override 总数(供应商级标志 + 全部逐模型条目)。与烘进
    // 模型条目的 disabled 标志不同,它**包含指向已下架模型的陈旧条目** —— 设置页
    // 据此决定是否展示「全部启用」组级恢复入口:目录漂移后 override 仍在、却没有
    // 任何行可渲染时,恢复入口不能消失(PR #744 review 第二十六轮)。
    const disableOverrideCount =
      (suspended ? 1 : 0) + disabledKeys.filter((k) => k.startsWith(`${p.id}:`)).length;
    // 停用标志烘焙进模型条目(视图层字段,见 CatalogModel.disabled):renderer 与
    // device-link 控制端直接消费,不需要各自再查一份 override 表。**只有确实带停用
    // 条目的供应商**才重建 models(按 key 前缀判;listProviders 是热路径,其余供应商
    // 原引用透传零分配 —— PR #744 review)。前缀误命中(如 'a:' 命中 'a:b:model')只
    // 多做一次无害映射,不影响正确性。
    let models = p.models;
    let mediaOverrides: Pick<Provider, 'imageModels' | 'videoModels'> = {};
    if (disabledKeys.length > 0 && disabledKeys.some((k) => k.startsWith(`${p.id}:`))) {
      const mapped: Provider['models'] = {};
      for (const agent of Object.keys(p.models) as AgentKind[]) {
        mapped[agent] = (p.models[agent] ?? []).map((m) =>
          isModelDisabled(access, p.id, m.id) ? { ...m, disabled: true } : m,
        );
      }
      models = mapped;
      // 专属媒体清单(imageModels/videoModels,不挂 agent)同样烘焙停用标志:
      // 设置页据此渲染/切换只经媒体清单下发的图像、视频型号(PR #744 review)。
      const mapMedia = (list: NonNullable<Provider['imageModels']>) =>
        list.map((m) => (isModelDisabled(access, p.id, m.id) ? { ...m, disabled: true } : m));
      mediaOverrides = {
        ...(p.imageModels ? { imageModels: mapMedia(p.imageModels) } : {}),
        ...(p.videoModels ? { videoModels: mapMedia(p.videoModels) } : {}),
      };
    }
    return {
      ...p,
      models,
      ...mediaOverrides,
      connected: connected[p.id] ?? false,
      ...(suspended ? { suspended: true } : {}),
      ...(disableOverrideCount > 0 ? { disableOverrideCount } : {}),
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

/**
 * 该 agent 已连接的供应商 —— 模型选择器「来源栏」用。停用(suspended)的供应商不可
 * 作为新路由,默认一并剔除。`includeSuspended` 保留 suspended 来源 —— 给**已建会话**
 * 的鉴权/发送门禁用(运行中会话不因停用打断,门禁只回答「凭证还连着吗」,把停用当
 * 未鉴权会误禁发送;PR #744 review 第十轮)。新路由消费方不要传。
 */
export function connectedProvidersForAgent(
  views: ProviderView[],
  agent: AgentKind,
  opts: { includeSuspended?: boolean } = {},
): ProviderView[] {
  // 两道正交的剔除:runtime 级 disabled(目录 routing 声明,上游 #526)与用户的
  // 供应商级停用(suspended,model-disable-store)—— 任一命中都不可路由。
  return views.filter(
    (p) =>
      p.connected &&
      (opts.includeSuspended === true || !p.suspended) &&
      hasEnabledAgentRuntime(p, agent),
  );
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
  opts: { onlyConnected?: boolean; includeDisabled?: boolean } = {},
): ProviderView[] {
  const onlyConnected = opts.onlyConnected ?? true;
  // suspended 供应商与**该来源下被停用的模型条目**默认出局:本函数的产出是
  // 「可路由来源」(选择器 activeSourceId / effectiveSourceIdForModel / Fast 门控),
  // 停用的那份拷贝即便凭证在场也不允许被路由到 —— 同 id 模型在 A 家停用、B 家
  // 启用时,默认来源解析必须落到 B,而不是继续把 A 当候选(PR #744 review)。
  // `includeDisabled` 保留停用条目(suspended / model.disabled)—— 给准入守卫
  // (model-route-guard)推演「不考虑停用时会路由到谁」用,普通消费方不要传。
  const includeDisabled = opts.includeDisabled === true;
  return views.filter(
    (p) =>
      (includeDisabled || !p.suspended) &&
      (!onlyConnected || p.connected) &&
      hasEnabledAgentRuntime(p, agent) &&
      providerOffersModel(p, modelId, agent) &&
      (includeDisabled || getModel(p, modelId, agent)?.disabled !== true),
  );
}

/**
 * 同 sourcesForModel,但只保留该来源上**这个模型条目本身确实是聊天模型**的来源
 * (issue #882 第 3 点,2026-07 review)。所有"这个来源能不能真的把这个模型发出去"
 * 的判断——路由解析、发送前置校验(空来源拦截)、"选中来源已断连"提示——必须走
 * 同一份口径,否则会出现 UI 说"能发"、resolveRoute 却解析不出可用来源的分裂状态。
 * 只在裸 `sourcesForModel`(仅看 id 是否存在,不看 mode)不够用的场景才需要这个;
 * 纯展示/设置页场景仍应直接用 sourcesForModel,不要在那里过度收紧。
 */
export function chatEligibleSourcesForModel(
  views: ProviderView[],
  modelId: string,
  agent: AgentKind,
  opts: { onlyConnected?: boolean; includeDisabled?: boolean } = {},
): ProviderView[] {
  return sourcesForModel(views, modelId, agent, opts).filter((provider) => {
    const model = getModel(provider, modelId, agent);
    // provider-aware 谓词而非裸 isChatEligible:用户自定义供应商显式配置的模型带未知
    // group,id 撞上能力启发式(如 flux-image-x)时不能被误杀(2026-07 review 第 25 轮)。
    return (
      model !== undefined &&
      isAgentSelectableModel(model, { userProvider: provider.source === 'user' })
    );
  });
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
 * 当前模型没有任何已连接且可用于新路由的来源时返回 null。retired tombstone 与本地
 * disabled 都不参与本函数；运行中会话的真实来源展示必须改用 actualSourceIdForModel。
 */
export function effectiveSourceIdForModel(
  views: ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  agent: AgentKind,
): string | null {
  const sources = chatEligibleSourcesForModel(views, modelId, agent).filter((provider) => {
    const model = getModel(provider, modelId, agent);
    return (
      model !== undefined &&
      isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })
    );
  });
  if (providerId && sources.some((provider) => provider.id === providerId)) return providerId;
  return nativeDefaultSourceId(sources, agent);
}

/**
 * 「实际路由口径」的来源解析:选择规则与 effectiveSourceIdForModel 相同,但**不**
 * 剔除停用拷贝(includeDisabled rail)。给「展示一个已在运行的会话」用:运行中的
 * 会话不因停用打断,实际路由层对隐式来源仍落原生默认、对显式来源仍用会话存的值 ——
 * 图标 / 价格 / Fast / 选中行豁免必须跟实际路由一致,不能显示成准入过滤后的替代
 * 来源(PR #744 review 第五轮)。**新路由选择**(新会话 / 切模型 / worker / schedule)
 * 一律用 effectiveSourceIdForModel,不要用本函数。
 */
export function actualSourceIdForModel(
  views: ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  agent: AgentKind,
): string | null {
  // Resume keeps disabled/retired copies, but never relaxes the agent/chat capability boundary:
  // a catalog correction that reclassifies an id as image/audio must not make a running agent
  // session dispatch into a non-chat endpoint.
  const sources = chatEligibleSourcesForModel(views, modelId, agent, { includeDisabled: true });
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
