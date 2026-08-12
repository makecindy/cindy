/**
 * unifiedSelection —— 统一模型选择器(模型优先)的**纯逻辑层**:推荐引擎推导 +
 * 跨引擎联合列表构建。规格见 `docs/product-rules/model-selector-unified.md`
 * §2.1(推荐引擎推导)/ §2.2((模型,引擎) 能力)/ §4(特殊情况检查表)。
 *
 * 一句话:用户只选模型,引擎(harness)由本模块从**既有目录结构**推导 —— 不新增任何
 * wire 字段、不新增服务端下发项。
 *
 * ## 三条硬约束
 *
 * 1. **先解析生效来源再查能力**。候选引擎、Fast、上下文、effort 一律按
 *    (provider, agent, model) 三元组现查,**禁止读跨供应商拍平去重后的列表** ——
 *    那只保留首见供应商的值,同 id 多来源时会取到另一条路由的元数据
 *    (registry.ts `modelSupportsFastMode` / CatalogModel.supportsFastMode 明示)。
 *    本模块的来源解析统一走 `effectiveSourceIdForModel`(草稿口径)或
 *    `actualSourceIdForModel`(运行中会话口径,含停用拷贝)。
 * 2. **推荐引擎必须是候选之一**。推荐是要落到一个真能路由的 (provider, agent) 上的;
 *    推荐一个当前不可选的引擎 = 假按钮。所有 root 偏好在不是候选时一律回落。
 * 3. **零 IO、零 any、纯函数**。可见性口径由调用方注入(见 `unifiedModelEntries`
 *    的 `isVisible`)—— 本包不得反向依赖 apps/desktop。
 *
 * ## 不在本层处理的事(由调用层负责)
 *
 * - `status:'retired'` 的 **keepSelected 豁免**:运行中会话即便模型已被服务端判死也要
 *   继续显示选中行(modelList.ts 内建准入过滤 + `keepSelected`)。本模块的联合列表走
 *   「新路由准入」口径(`isModelSelectableForNewRoute`),retired / disabled 条目不会
 *   出现;要保留选中行的调用方应把该行**单独**并进结果,并按 `scope:'session'` 查
 *   候选与能力(`actualSourceIdForModel` 不剔除停用拷贝)。
 * - 用户的引擎 override(`xdt:modelEnginePrefs`)与收藏副本:本模块只给「推荐」,
 *   override 覆盖推荐的合成在 renderer store(M2)完成。
 * - 区域 / SSH / device-link 的额外排除:经 `excludeProvider` / `excludeModel` 注入。
 */

import {
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  getModel,
  modelSupportsFastMode,
  type ProviderView,
} from './registry.js';
import { deriveModelList, type ProviderScope } from './modelList.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX, isBudgetModel } from './classification.js';
import type { AgentKind, CatalogModel, Effort, Provider } from './types.js';

/**
 * 引擎优先序 —— 联合列表的行合并序、以及推荐回落序的**唯一定义**。
 *
 * 与 renderer `selectVisibleModels` 的合并序(cc → codex → pi 首见胜出,
 * apps/desktop/src/renderer/lib/providerModels.ts)一致,也与 user-provider.ts 的
 * `AGENT_ORDER` 一致 —— 三处同序不是巧合:cc 是覆盖面最广的运行时,pi 是通用兜底。
 */
export const UNIFIED_AGENT_PRIORITY: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * 推荐引擎**永不**主动落在 pi 上:pi 是"什么都能跑"的通用兜底(客户端投影,wire enum
 * 里根本没有 pi,见 modelPlanePolicy.ts 头注),不是任何模型的最佳去处。唯一例外是
 * 它是**唯一候选**(如只配了 pi runtime 的自定义供应商)—— 那时推荐它不是选择,是事实。
 */
const NEVER_RECOMMENDED_UNLESS_SOLE: AgentKind = 'pi';

/**
 * 内置供应商的 **root agent 偏好表** —— 镜像 host 侧的 `MODEL_PLANE_POLICIES`
 * (apps/desktop/src/main/maker-host/model-plane/modelPlanePolicy.ts:50):
 *   - openai:    roots ['codex']                → 推荐 codex(cc / pi 上的是 `chatgpt/` bridge 投影)
 *   - anthropic: roots ['claude-code']          → 推荐 claude-code(codex 上的是 anthropic-messages bridge)
 *   - xai:       roots ['claude-code','codex']  → 双 root,piRoot = claude-code ⇒ 取 claude-code
 *
 * 为什么是抄一份表而不是 import:本包是零依赖的下层(apps/desktop 依赖它,反向依赖是
 * 架构不变量禁止的)。host 那张表还承载实体化 / membership / transforms 三件事,本表只
 * 取其中「canonical root 落在哪个 agent」这一维。两表漂移的后果是推荐档变差(不会变成
 * 假按钮 —— 约束 2 兜底),新增内置供应商时两处都要加。
 *
 * **xd 刻意不在表内**,与 host 同因:网关独占存在性,root 概念不适用(见
 * `gatewayRootPreference`)。
 */
const BUILTIN_ROOT_PREFERENCE: ReadonlyMap<string, AgentKind> = new Map([
  ['openai', 'codex'],
  ['anthropic', 'claude-code'],
  ['xai', 'claude-code'],
]);

/**
 * 分类用的 id 归一:剥掉 bridge 命名空间前缀(`chatgpt/` / `xai/`)与 `[1m]` 长上下文后缀。
 *
 * 规格 §4:「bridge 条目 id 带前缀…按 id 查推荐 / 能力时先归一」。归一**只用于分类判定**
 * (是不是折扣路由条目),不用于候选集判定 —— 候选必须是目录里真实存在、真能路由的那条
 * (provider, agent, id),见 `candidateAgentsForModel` 的注释。
 */
export function normalizeModelIdForClassification(modelId: string): string {
  let id = modelId;
  for (const prefix of [CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX]) {
    if (id.startsWith(prefix)) id = id.slice(prefix.length);
  }
  return id.replace(/\[1m\]$/, '');
}

/**
 * 目录条目查找的候选 id 列表 —— 与 host 的
 * `getCatalogModelContextWindow`(apps/desktop/src/main/maker-host/active-catalog.ts:750)
 * **同口径**:原 id → 去 `[1m]` 后缀 → 去该路由的 `modelIdRewrite.stripPrefix` → 两者叠加。
 *
 * 用途:会话侧存的是 **wire model id**,可能带 `[1m]` 展示后缀,或被路由的 stripPrefix
 * 包了一层;目录始终存原始 id。归一在这里做一次,消费方不必各自复制一份匹配逻辑。
 */
export function catalogModelIdCandidates(modelId: string, stripPrefix?: string): string[] {
  const out = new Set<string>([modelId, modelId.replace(/\[1m\]$/, '')]);
  if (stripPrefix && modelId.startsWith(stripPrefix)) {
    const stripped = modelId.slice(stripPrefix.length);
    out.add(stripped);
    out.add(stripped.replace(/\[1m\]$/, ''));
  }
  return [...out];
}

/**
 * 取 (provider, agent) 下的目录条目,精确 id 优先、失配时按 `catalogModelIdCandidates`
 * 归一重试。**注意 `[1m]` 变体若在目录里独立存在就是独立行**(如 `claude-opus-5` 与
 * `claude-opus-5[1m]` 是两个上下文窗口不同的条目),精确优先保证不会互相顶替。
 */
export function findCatalogModel(
  provider: Provider | ProviderView | undefined,
  modelId: string,
  agent: AgentKind,
): CatalogModel | undefined {
  if (!provider) return undefined;
  const exact = getModel(provider, modelId, agent);
  if (exact) return exact;
  const stripPrefix = provider.routing?.[agent]?.modelIdRewrite?.stripPrefix;
  for (const candidate of catalogModelIdCandidates(modelId, stripPrefix)) {
    const found = getModel(provider, candidate, agent);
    if (found) return found;
  }
  return undefined;
}

/**
 * 来源解析口径:
 *   - `'draft'`(默认)—— `effectiveSourceIdForModel`:新会话 / 切模型 / worker / schedule
 *     等**新路由**场景,剔除停用与 retired;
 *   - `'session'` —— `actualSourceIdForModel`:展示**已在运行的会话**,保留停用拷贝,
 *     与实际路由一致(registry.ts 明示两套口径必须都保留)。
 */
export type SourceResolutionScope = 'draft' | 'session';

export interface CandidateAgentsOptions {
  /** 来源解析口径,默认 `'draft'`。 */
  scope?: SourceResolutionScope;
  /** 限定参与推导的引擎集合(默认全部三个,顺序仍按 `UNIFIED_AGENT_PRIORITY`)。 */
  agents?: readonly AgentKind[];
}

function resolveSourceId(
  providers: readonly ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  agent: AgentKind,
  scope: SourceResolutionScope,
): string | null {
  const views = [...providers];
  return scope === 'session'
    ? actualSourceIdForModel(views, providerId, modelId, agent)
    : effectiveSourceIdForModel(views, providerId, modelId, agent);
}

/**
 * 该 (provider, model) 的**候选引擎**:在最终目录中,这个模型确实能由这个供应商在该
 * agent 下路由的全部 agent。
 *
 * 判定方式 = 逐 agent 跑一遍生效来源解析,看解析结果是否就是 `providerId`。这样一次性
 * 吃到 registry 的全部口径:该 agent 的 runtime 是否启用、供应商是否已连接 / 停用、该
 * 条目是不是聊天模型、是否被本地停用或 retired —— 而不是去读拍平去重列表里那条可能
 * 属于别家供应商的行(规格 §2.1 / §4 明令禁止)。
 *
 * `providerId` 传 `null` / `undefined` = 「跟随默认路由」(草稿未显式选源):此时候选 =
 * 该模型在该 agent 下**存在任何可路由来源**的 agent(解析结果非 null)。
 *
 * **候选按精确 id 判定,不做归一**:候选 = 「选了这个引擎之后,这条 id 真的发得出去」。
 * `chatgpt/gpt-5.5`(openai 在 cc / pi 下的 bridge 条目)与 `gpt-5.5`(openai 在 codex 下的
 * root 条目)是两条不同的 id、两行不同的选择器条目,归一合并会造出「选了 codex 却发一个
 * codex 目录里不存在的 id」的假按钮。归一只用于分类与能力回查(见上面两个 helper)。
 */
export function candidateAgentsForModel(
  providers: readonly ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  opts: CandidateAgentsOptions = {},
): AgentKind[] {
  const scope = opts.scope ?? 'draft';
  const allowed = opts.agents;
  return UNIFIED_AGENT_PRIORITY.filter((agent) => {
    if (allowed && !allowed.includes(agent)) return false;
    const sourceId = resolveSourceId(providers, providerId, modelId, agent, scope);
    if (sourceId === null) return false;
    // providerId 缺席 = 跟随默认路由:解析出任何来源即算该引擎可用。
    return providerId ? sourceId === providerId : true;
  });
}

/**
 * 网关(XD)的 root 偏好 —— 网关同时服务 cc / codex 两个面,没有 root 概念,按**条目本身**判:
 *   - 折扣路由条目(`codex/` 前缀,或服务端显式下发 `group:'gpt-budget'`)→ codex:
 *     `codex/` 是网关转发给 OpenAI Responses 那条低价路由的命名空间(见 types.ts
 *     `RoutingDescriptor.modelIdRewrite` 的示例与 classification.ts `categorize` 里
 *     「`codex/` 前缀 ⇒ gpt-budget」的判定),归属天然是 Codex 侧;
 *   - 其余 → claude-code:网关的 `/v1/messages` 翻译面覆盖最广,也是服务端未声明
 *     `agents` 时的默认 tab(active-catalog.ts `xdGatewayTargetAgents` 默认 ['claude-code'])。
 *   - 「该模型仅在 codex 下」不需要在这里表达 —— 单候选规则已经吃掉了它。
 *
 * 折扣判定复用 `isBudgetModel`(数据优先:合法 `group` 说了算,否则 `codex/` 前缀兜底),
 * 而不是自己写一遍前缀判断 —— classification.ts 已经把这条语义收成单点,再抄一份就是
 * 那类会漂移的重复。
 */
function gatewayRootPreference(model: CatalogModel | undefined, modelId: string): AgentKind {
  const id = normalizeModelIdForClassification(modelId);
  const budget = model
    ? isBudgetModel({ id, ...(model.group !== undefined ? { group: model.group } : {}) })
    : isBudgetModel({ id });
  return budget ? 'codex' : 'claude-code';
}

/**
 * 该供应商是否为「共享网关」形态 —— 数据判定,不是 id 白名单:任一 runtime 的鉴权策略是
 * `gateway-key` 即网关(XD 的三个 runtime 都是,见 builtin.ts XD_PROVIDER.routing)。
 * 将来接入第二家网关时无需改这里。
 */
function isGatewayProvider(provider: Provider | ProviderView): boolean {
  return Object.values(provider.routing).some(
    (routing) => routing?.authStrategy === 'gateway-key',
  );
}

/**
 * root 偏好(尚未与候选集求交)。返回 `null` = 没有偏好,直接走候选优先序回落。
 *
 * 顺序有讲究:内置 root 表 → 网关 → 用户自定义供应商。用户自定义供应商**没有** root
 * 偏好:它的"配置了哪些 runtime"已经完整体现在候选集里(buildUserProvider 只为
 * `runtimes` 里配了的 agent 生成 routing + models),多 runtime 时按 cc > codex > pi 取,
 * 这正是 `UNIFIED_AGENT_PRIORITY` 的回落序 —— 所以这里返回 null 而不是抄一份优先序。
 */
function rootPreference(
  provider: Provider | ProviderView,
  modelId: string,
  candidates: readonly AgentKind[],
): AgentKind | null {
  const builtin = BUILTIN_ROOT_PREFERENCE.get(provider.id);
  if (builtin) return builtin;
  if (isGatewayProvider(provider)) {
    // 能力元数据按「该偏好指向的 agent」现查;查不到就用任一候选条目兜底判分组。
    const preferredProbe = findCatalogModel(provider, modelId, 'codex');
    const anyProbe =
      preferredProbe ??
      candidates.map((agent) => findCatalogModel(provider, modelId, agent)).find(Boolean);
    return gatewayRootPreference(anyProbe, modelId);
  }
  return null;
}

/**
 * 在给定候选集里挑推荐引擎 —— 推导规则的**单点实现**(公开出来供联合列表与调用方复用,
 * 保证「行上显示的推荐」与「单独查的推荐」永远同一份逻辑)。
 *
 * 1. 无候选 → null(没有可推荐的东西,不编);
 * 2. 单候选 → 即它(pi 唯一候选时也推荐 pi);
 * 3. root 偏好命中候选 → 用它(内置表 / 网关按条目判);
 * 4. 回落:候选里按 cc > codex 取第一个;都没有则 pi。
 *
 * 约束 2(推荐必是候选)由 3、4 共同保证:偏好不是候选就一定回落。
 */
export function pickRecommendedAgent(
  provider: Provider | ProviderView | undefined,
  modelId: string,
  candidates: readonly AgentKind[],
): AgentKind | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (provider) {
    const preferred = rootPreference(provider, modelId, candidates);
    if (preferred && candidates.includes(preferred)) return preferred;
  }
  const fallback = UNIFIED_AGENT_PRIORITY.find(
    (agent) => agent !== NEVER_RECOMMENDED_UNLESS_SOLE && candidates.includes(agent),
  );
  return fallback ?? (candidates.includes(NEVER_RECOMMENDED_UNLESS_SOLE) ? 'pi' : null);
}

/**
 * 该 (provider, model) 的**推荐引擎**。候选先按 `candidateAgentsForModel` 解析生效来源
 * 得出,再走 `pickRecommendedAgent`。无任何候选(模型不可路由)时返回 `null` ——
 * 调用方不该拿一个不可路由的模型来问推荐,返回 null 比编一个假答案诚实。
 */
export function recommendedAgentForModel(
  providers: readonly ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  opts: CandidateAgentsOptions = {},
): AgentKind | null {
  const candidates = candidateAgentsForModel(providers, providerId, modelId, opts);
  if (candidates.length === 0) return null;
  // providerId 缺席(跟随默认路由)时,root 偏好按**最高优先候选引擎**下解析出的默认来源判:
  // 那正是用户不显式选源时真的会路由过去的那家。
  const sourceId =
    providerId ?? resolveSourceId(providers, null, modelId, candidates[0], opts.scope ?? 'draft');
  const provider = sourceId ? providers.find((entry) => entry.id === sourceId) : undefined;
  return pickRecommendedAgent(provider, modelId, candidates);
}

/** 某 (provider, model, agent) 已解析的能力三元组(规格 §2.2)。 */
export interface UnifiedAgentCapability {
  agent: AgentKind;
  /** 该 (provider, agent) 条目声明的思考档;空数组 = 不可调。 */
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  /**
   * 该 (provider, agent, model) 的 Fast 能力 —— 走 `modelSupportsFastMode` 现查。
   * **不含 agent 运行时的粗粒度 gate**(`capabilities.hasFastMode`):那是 host 侧的
   * 运行期事实,本包拿不到,由渲染层叠加(registry.ts 明示)。
   */
  supportsFastMode: boolean;
  /** 该 (provider, agent) 下的上下文窗口(同 id 跨 agent 可不同,如 gpt-5.5 cc=1M / codex=272K)。 */
  contextWindow: number;
  /** 该窗口是否为显式声明的真实上限(`CatalogModel.contextWindowVerified`)。 */
  contextWindowVerified: boolean;
}

/**
 * 解析单个 (provider, model, agent) 的能力。找不到条目返回 null。
 * 供浮层「来源·上下文按当前选中引擎实时变」用。
 */
export function resolveAgentCapability(
  providers: readonly ProviderView[],
  providerId: string,
  modelId: string,
  agent: AgentKind,
): UnifiedAgentCapability | null {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) return null;
  return capabilityOf(provider, modelId, agent);
}

function capabilityOf(
  provider: ProviderView,
  modelId: string,
  agent: AgentKind,
): UnifiedAgentCapability | null {
  const model = findCatalogModel(provider, modelId, agent);
  if (!model) return null;
  return {
    agent,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
    // 归一命中时按目录里真实那条 id 查 Fast,避免 `[1m]` 变体查不到而误报 false。
    supportsFastMode: modelSupportsFastMode(provider, model.id, agent),
    contextWindow: model.contextWindow,
    contextWindowVerified: model.contextWindowVerified === true,
  };
}

/** 联合列表的一行:一个 (provider, model),横跨它能用的所有引擎。 */
export interface UnifiedModelEntry {
  providerId: string;
  modelId: string;
  /** 展示名 —— 取**推荐引擎**那条目录条目(同 id 跨 agent 元数据可不同)。 */
  displayName: string;
  description?: string;
  /** 分组 / 排序:面板右栏按服务端下发的 group + sortOrder 陈列(规格 §1.2)。 */
  group?: string;
  sortOrder?: number;
  /** 展示图标 id(`CatalogModel.icon`;缺省由渲染层回落供应商标)。 */
  icon?: string;
  /** 该行的来源供应商是否已连接(providerScope 放宽时才有区分意义)。 */
  sourceConnected: boolean;
  /** 候选引擎,按 `UNIFIED_AGENT_PRIORITY` 序。恒 ≥1(空候选的行不产出)。 */
  candidates: AgentKind[];
  /** 推荐引擎,恒 ∈ candidates。 */
  recommended: AgentKind;
  /** 逐候选引擎已解析的能力。键集 = candidates。 */
  capabilities: Partial<Record<AgentKind, UnifiedAgentCapability>>;
}

export interface UnifiedModelEntriesOptions {
  providers: readonly ProviderView[];
  /** 参与联合的引擎;缺省 = 全部三个。 */
  agents?: readonly AgentKind[];
  /**
   * 供应商范围,默认 `'connected-for-agent'` —— 与 `visibleModelUnion`(选择器口径)一致,
   * 也与来源解析对齐:`effectiveSourceIdForModel` 只认已连接来源,放宽 scope 也长不出
   * 候选,只会产出空候选行(会被丢弃)。要列「去连接引导」清单的调用方自己另走一条派生。
   */
  providerScope?: ProviderScope;
  /**
   * 可见性谓词(用户「设置 → 模型供应商」的显隐 override)。带 `agent` 维度 —— 显隐 key
   * 是 `<agent>:<providerId>:<modelId>`(见 renderer `isDeviceModelVisible`),同 id 在
   * cc / codex 下可以一显一隐。缺省 = 不过滤。
   *
   * 刻意做成注入而不是在包里读存储:可见性数据源在 renderer localStorage / 被控端投影,
   * 本包不得反向依赖 app(架构不变量)。
   */
  isVisible?: (providerId: string, model: CatalogModel, agent: AgentKind) => boolean;
  /** 整供应商排除(SSH 远程排除 chat-bridged Codex 源等)。 */
  excludeProvider?: (provider: ProviderView, agent: AgentKind) => boolean;
  /** 单模型排除(SSH 远程排除订阅直连前缀等)。 */
  excludeModel?: (model: CatalogModel, provider: ProviderView, agent: AgentKind) => boolean;
  /** 来源解析口径,默认 `'draft'`。 */
  scope?: SourceResolutionScope;
}

function entryKey(providerId: string, modelId: string): string {
  // model id 可含 ':'(命名空间写法很少,但 provider id 受 /^[a-z0-9_-]+$/ 约束不含 ':'),
  // 故以**首个** ':' 切分即可无歧义还原;这里只做 Map 键,不落盘不过 wire。
  return `${providerId}:${modelId}`;
}

/**
 * 跨引擎联合列表 —— 统一选择器面板的行数据源(规格 §1.2 / §2.1)。
 *
 * 形状:每个可见 (provider, model) **一行**,行上带候选引擎、推荐引擎与逐引擎能力。
 * 这与旧版「先选引擎再选模型」的分面清单是两种形状:旧版 `selectVisibleModels` 把
 * cc / codex / pi 三份清单按 **model id** 首见去重合并成一列(丢掉了来源与另一引擎的
 * 能力);本函数不去重、按 (provider, model) 聚合,同 id 多来源各出一行(收藏是配置
 * 副本、来源徽章与价格都按行来源判,规格 §1.2 / §4)。
 *
 * 顺序契约:引擎按 `UNIFIED_AGENT_PRIORITY` 外层遍历,每个引擎内按标准派生序
 * (供应商 rail 序 = catalog 序,供应商内目录序);行的位置由它**首次出现**的引擎决定。
 * 与 `selectVisibleModels` 的 cc → codex → pi 合并序同构。展示分组/排序另走
 * `groupModelsForDisplay`,本函数**不二次排序**。
 *
 * 准入:复用 `deriveModelList` 的标准派生(非聊天模型 / `disabled` / `retired` 内建过滤),
 * 再叠一层「生效来源必须就是本行来源」的校验(见 `candidateAgentsForModel`)。空候选的
 * 行整行丢弃 —— 一行没有任何能跑它的引擎就不该出现在选择器里。
 */
export function unifiedModelEntries(opts: UnifiedModelEntriesOptions): UnifiedModelEntry[] {
  const {
    providers,
    agents,
    providerScope = 'connected-for-agent',
    isVisible,
    excludeProvider,
    excludeModel,
    scope = 'draft',
  } = opts;

  const activeAgents = UNIFIED_AGENT_PRIORITY.filter(
    (agent) => agents === undefined || agents.includes(agent),
  );

  /** key → { 行序位置, 该行被枚举到的引擎集合 } */
  const seen = new Map<string, { index: number; agents: AgentKind[]; connected: boolean }>();
  const order: Array<{ providerId: string; modelId: string }> = [];

  for (const agent of activeAgents) {
    const rows = deriveModelList({
      providers,
      agent,
      providerScope,
      // 同 id 多来源必须各出一行:联合列表按 (provider, model) 聚合,拍平去重会把
      // 另一来源的能力/徽章张冠李戴(规格 §4「同名模型多来源」)。
      dedupe: 'none',
      ...(isVisible ? { isVisible: (pid, model) => isVisible(pid, model, agent) } : {}),
      ...(excludeProvider ? { excludeProvider: (provider) => excludeProvider(provider, agent) } : {}),
      ...(excludeModel
        ? { excludeModel: (model, provider) => excludeModel(model, provider, agent) }
        : {}),
    });
    for (const row of rows) {
      const key = entryKey(row.sourceProviderId, row.id);
      const hit = seen.get(key);
      if (hit) {
        if (!hit.agents.includes(agent)) hit.agents.push(agent);
        continue;
      }
      seen.set(key, {
        index: order.length,
        agents: [agent],
        connected: row.sourceConnected,
      });
      order.push({ providerId: row.sourceProviderId, modelId: row.id });
    }
  }

  const out: UnifiedModelEntry[] = [];
  for (const { providerId, modelId } of order) {
    const hit = seen.get(entryKey(providerId, modelId));
    if (!hit) continue;
    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider) continue;
    // 枚举到的引擎 ∩ 生效来源解析确认的引擎 —— 两道都过才算候选(约束 1)。
    const resolved = candidateAgentsForModel(providers, providerId, modelId, {
      scope,
      agents: hit.agents,
    });
    const candidates = UNIFIED_AGENT_PRIORITY.filter(
      (agent) => hit.agents.includes(agent) && resolved.includes(agent),
    );
    if (candidates.length === 0) continue;
    const recommended = pickRecommendedAgent(provider, modelId, candidates);
    if (recommended === null) continue;
    const capabilities: Partial<Record<AgentKind, UnifiedAgentCapability>> = {};
    for (const agent of candidates) {
      const capability = capabilityOf(provider, modelId, agent);
      if (capability) capabilities[agent] = capability;
    }
    // 展示元数据取推荐引擎那条(同 id 跨 agent 元数据可不同);推荐引擎恒是候选,
    // 其条目必然存在,但仍按 undefined 兜底,不用非空断言。
    const display =
      findCatalogModel(provider, modelId, recommended) ??
      findCatalogModel(provider, modelId, candidates[0]);
    out.push({
      providerId,
      modelId,
      displayName: display?.name ?? modelId,
      ...(display?.description !== undefined ? { description: display.description } : {}),
      ...(display?.group !== undefined ? { group: display.group } : {}),
      ...(display?.sortOrder !== undefined ? { sortOrder: display.sortOrder } : {}),
      ...(display?.icon !== undefined ? { icon: display.icon } : {}),
      sourceConnected: hit.connected,
      candidates,
      recommended,
      capabilities,
    });
  }
  return out;
}
