/**
 * unifiedSelection —— 统一模型选择器(模型优先)的**纯逻辑层**:逻辑模型行合并、
 * 推荐引擎推导、原生底座排序。规格见 `docs/product-rules/model-selector-unified.md`
 * §2.1(推荐引擎推导)/ §2.2((模型,引擎) 能力)/ §4(特殊情况检查表)。
 *
 * 一句话:用户只选模型,引擎(harness)由本模块从**既有目录结构**推导 —— 不新增任何
 * wire 字段、不新增服务端下发项。
 *
 * ## ⚠️ 行身份 key 口径(2026-08-13 变更,面板层必读)
 *
 * 一行 = 一个**逻辑模型** = `(providerId, 归一化 modelId)`。归一化 = 剥掉 bridge
 * 命名空间前缀(`chatgpt/` / `xai/`)。同一个模型在不同引擎下的 wire id 可以不同 ——
 * OpenAI 包月的 GPT-5.6-Luna 在 codex 下是 `gpt-5.6-luna`、在 cc/pi 下是
 * `chatgpt/gpt-5.6-luna` —— 早先版本按精确 id 建行,用户就看到了**两行同名模型**。
 *
 * 现在:合并成一行,每个引擎的真实 wire id 落在 `capabilities[agent].wireModelId`。
 *   - `UnifiedModelEntry.modelId` = **归一化 id**,是行的稳定身份:引擎 override
 *     (`xdt:modelEnginePrefs`)、收藏副本(`xdt:modelFavorites`)、选中态都用它做 key。
 *   - **发请求 / 写 draft / 建会话时必须用 `capabilities[<选中引擎>].wireModelId`**,
 *     绝不能拿 `modelId` 直接发 —— 那正是「不做假按钮」约束要挡的事(归一化 id 在
 *     bridge 引擎的目录里根本不存在)。
 *
 * **不合并**的两类,刻意保留为独立行:
 *   - `[1m]` 后缀变体(`claude-opus-5` vs `claude-opus-5[1m]`):它们是窗口不同的两个
 *     可售条目,合并会让用户选不到长上下文那条;
 *   - `codex/` 折扣路由前缀(`gpt-5.5` vs `codex/gpt-5.5`):同名但不同价、不同路由,
 *     是两个真实商品(见 classification.ts `isBudgetModel`)。
 *
 * ## 三条硬约束
 *
 * 1. **先解析生效来源再查能力**。候选引擎、Fast、上下文、effort 一律按
 *    (provider, agent, wire id) 三元组现查,**禁止读跨供应商拍平去重后的列表** ——
 *    那只保留首见供应商的值,同 id 多来源时会取到另一条路由的元数据
 *    (registry.ts `modelSupportsFastMode` / CatalogModel.supportsFastMode 明示)。
 * 2. **推荐引擎必须是候选之一**,且每个候选都必须有可发的 wire id。
 * 3. **零 IO、零 any、纯函数**。可见性口径由调用方注入 —— 本包不得反向依赖 apps/desktop。
 *
 * ## 不在本层处理的事(由调用层负责)
 *
 * - **来源之外的可见性策略**:可见性谓词由调用方注入(本包不读用户偏好)。
 *   注意 `scope:'session'` 只管**来源解析**那一步;`disabled` / `status:'retired'` 的选中行
 *   要留在列表里,得由调用方传 `unifiedModelEntries` 的 `keepModel`(与 `deriveModelList`
 *   的 `keepSelected` 同一条既有约定)。豁免**按 agent 收窄**:只放行「当前正在跑的那一格」,
 *   同一行其它引擎上的目录副本照常受准入与来源校验。
 * - 用户的引擎 override 与收藏副本:本模块只给「推荐」,override 合成在 renderer store(M2)。
 * - **effort 落档**:本模块给出的 `defaultEffort` 已应用「缺省回落 medium」(见
 *   `UnifiedAgentCapability.defaultEffort`),调用方必须把这个**已回落的值**传给
 *   `effortResolution.resolveEffort` 的 `defaultEffort` 参数。`resolveEffort` 自己的兜底
 *   仍是 `efforts[0]`(那是全仓共享的历史语义,不在本次改动范围)—— 不传就会出现
 *   「面板显示 medium、实际落 low」的分裂。
 */

import {
  actualSourceIdForModel,
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  modelSupportsFastMode,
  providerOffersModel,
  providersForAgent,
  type ProviderView,
} from './registry.js';
import { deriveModelList } from './modelList.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX, groupOf, isBudgetModel } from './classification.js';
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
 * 它是**唯一候选** —— 那时推荐它不是选择,是事实。
 */
const NEVER_RECOMMENDED_UNLESS_SOLE: AgentKind = 'pi';

/**
 * **bridge 命名空间前缀** —— 同一个逻辑模型被投影进非 root 引擎时套的壳。
 *   - `chatgpt/`:OpenAI codex root → cc / pi bridge(modelPlanePolicy.ts `toChatgptBridgeModel`,
 *     builtin.ts OPENAI routing 的 `modelPrefixes`);
 *   - `xai/`:xAI 订阅直连 bridge(catalog/providers.json 两个 runtime 都声明了 `modelPrefixes`)。
 * 与 classification.ts 的 `SUBSCRIPTION_DIRECT_MODEL_PREFIXES` 同源(直接引用其常量,
 * 不另抄字面量)。**`codex/` 不在此列** —— 它是折扣路由的商品命名空间,不是同一模型的壳。
 */
const BRIDGE_NAMESPACE_PREFIXES: readonly string[] = [CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX];

/**
 * 内置供应商的 **root agent 偏好表** —— 镜像 host 侧的 `MODEL_PLANE_POLICIES`
 * (apps/desktop/src/main/maker-host/model-plane/modelPlanePolicy.ts:50):
 *   - openai:    roots ['codex']                → codex(cc / pi 上的是 `chatgpt/` bridge 投影)
 *   - anthropic: roots ['claude-code']          → claude-code(codex 上的是 anthropic-messages bridge)
 *
 * 为什么是抄一份表而不是 import:本包是零依赖的下层(apps/desktop 依赖它,反向依赖是
 * 架构不变量禁止的)。host 那张表还承载实体化 / membership / transforms 三件事,本表只
 * 取其中「canonical root 落在哪个 agent」这一维。新增内置供应商时两处都要加。
 *
 * **只标确有主场的**(Chris 2026-08-13 裁决):xai 是多 root 全能选手(host 表
 * roots ['claude-code','codex'] 且 #2572 后三引擎皆正式成员),硬选一个会让它在
 * 其余引擎视图被错误降到「仅兼容」层 —— 刻意不入表,落 null = 无主场,任何视图
 * 不降级(`partitionEntriesByNativeAgent`)。服务端未来的 nativeAgent 字段同语义:可空,
 * 空 = 全场平等。
 *
 * **xd 刻意不在表内**,与 host 同因:网关独占存在性,root 概念不适用(非折扣网关行
 * 同样落 null,见 `nativeAgentForProviderModel` 头注)。
 */
const BUILTIN_ROOT_PREFERENCE: ReadonlyMap<string, AgentKind> = new Map([
  ['openai', 'codex'],
  ['anthropic', 'claude-code'],
]);

/**
 * **行身份 id**:剥掉 bridge 命名空间前缀,得到该逻辑模型的稳定 key。
 * 刻意**不**剥 `[1m]` 后缀与 `codex/` 前缀(见文件头「不合并」)。
 */
export function unifiedModelKeyId(modelId: string): string {
  for (const prefix of BRIDGE_NAMESPACE_PREFIXES) {
    if (modelId.startsWith(prefix)) return modelId.slice(prefix.length);
  }
  return modelId;
}

/**
 * 分类用的 id 归一:在 `unifiedModelKeyId` 之上再剥 `[1m]` 长上下文后缀。
 * 只用于「这是不是折扣路由条目」这类**分类判定**,不用于建行、不用于发请求。
 */
export function normalizeModelIdForClassification(modelId: string): string {
  return unifiedModelKeyId(modelId).replace(/\[1m\]$/, '');
}

/**
 * 目录条目查找的候选 id 列表 —— 覆盖两类归一:
 *   1. **bridge 壳**:行身份 id ↔ `chatgpt/` / `xai/` 前缀形态(支撑合并行);
 *   2. **wire 变体**:`[1m]` 展示后缀 + 该路由的 `modelIdRewrite.stripPrefix`,与 host 的
 *      `getCatalogModelContextWindow`(apps/desktop/src/main/maker-host/active-catalog.ts:750)
 *      同口径 —— 会话侧存的 wire model id 可能带 `[1m]`,而目录只有基础条目。
 * 顺序即优先级:精确 id 永远排第一,保证 `[1m]` 这类**独立存在**的条目不被变体顶替。
 *
 * ⚠️ `exact`(默认 false)—— **两类调用方口径不同,不能共用一张表**:
 *   - `exact: true`(候选推导 / wire id 解析,见 `resolveWireModelId`):**不剥 `[1m]`**。
 *     `glm-5.2[1m]` 与 `glm-5.2` 是两件商品(1M vs 标准窗口)。剥了以后,「cc 有
 *     `glm-5.2[1m]` + `glm-5.2`、codex 只有 `glm-5.2`」这种目录形状会让 `glm-5.2[1m]`
 *     的候选里混进 codex —— 用户在长上下文那行上换到 codex,发出去的却是标准窗口那条,
 *     正是「不做假按钮」要挡的事。bridge 壳与 `stripPrefix` 仍然归一(那两类是同一件
 *     商品的不同外壳,不是另一件商品)。
 *   - 默认(元数据回查:上下文窗口 / 分类 group / 展示名):允许回落基础条目,否则会话侧
 *     存着 `[1m]` 而目录只有基础条目时整个查不到,徽章与窗口数一起消失。
 */
export function catalogModelIdCandidates(
  modelId: string,
  stripPrefix?: string,
  opts: { exact?: boolean } = {},
): string[] {
  const out = new Set<string>([modelId]);
  const key = unifiedModelKeyId(modelId);
  out.add(key);
  for (const prefix of BRIDGE_NAMESPACE_PREFIXES) out.add(`${prefix}${key}`);
  if (opts.exact !== true) out.add(modelId.replace(/\[1m\]$/, ''));
  if (stripPrefix && modelId.startsWith(stripPrefix)) {
    const stripped = modelId.slice(stripPrefix.length);
    out.add(stripped);
    if (opts.exact !== true) out.add(stripped.replace(/\[1m\]$/, ''));
  }
  return [...out];
}

/**
 * 取 (provider, agent) 下的目录条目,精确 id 优先、失配时按 `catalogModelIdCandidates` 归一重试。
 * 返回的是**目录里真实那条**,调用方要发请求就用它的 `.id`(= wire id)。
 * `exact` 透传给候选表(见其头注:候选推导不许把 `[1m]` 落到另一件商品上)。
 */
export function findCatalogModel(
  provider: Provider | ProviderView | undefined,
  modelId: string,
  agent: AgentKind,
  opts: { exact?: boolean } = {},
): CatalogModel | undefined {
  if (!provider) return undefined;
  const stripPrefix = provider.routing?.[agent]?.modelIdRewrite?.stripPrefix;
  for (const candidate of catalogModelIdCandidates(modelId, stripPrefix, opts)) {
    const found = getModel(provider, candidate, agent);
    if (found) return found;
  }
  return undefined;
}

/**
 * 该 (provider, agent) 下这个逻辑模型真正要发出去的 **wire model id**;不提供则 null。
 * 面板选中某引擎后写 draft / 建会话 / 切模型,一律用本函数(或 `capabilities[agent].wireModelId`)
 * 的结果,不能用行的归一化 `modelId`。
 *
 * 走 `exact` 查找:这是**能不能路由**的判定,`[1m]` 变体不许回落到基础条目(见
 * `catalogModelIdCandidates` 头注)。
 */
export function resolveWireModelId(
  provider: Provider | ProviderView | undefined,
  modelId: string,
  agent: AgentKind,
): string | null {
  return findCatalogModel(provider, modelId, agent, { exact: true })?.id ?? null;
}

/**
 * 来源解析口径:
 *   - `'draft'`(默认)—— `effectiveSourceIdForModel`:新会话 / 切模型 / worker / schedule
 *     等**新路由**场景,剔除停用与 retired;
 *   - `'session'` —— `actualSourceIdForModel`:展示**已在运行的会话**,保留停用拷贝。
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
  wireModelId: string,
  agent: AgentKind,
  scope: SourceResolutionScope,
): string | null {
  const views = [...providers];
  return scope === 'session'
    ? actualSourceIdForModel(views, providerId, wireModelId, agent)
    : effectiveSourceIdForModel(views, providerId, wireModelId, agent);
}

/**
 * 该 (provider, 逻辑模型) 的**候选引擎**:这个模型确实能由这个供应商在该 agent 下路由的全部 agent。
 *
 * 两步,缺一不可:
 *   1. **解析 wire id** —— 该引擎的目录里到底有没有这条(bridge 壳 / `[1m]` / stripPrefix 归一后);
 *   2. **解析生效来源** —— 拿那条 wire id 跑 `effectiveSourceIdForModel`,看解析结果是否就是
 *      `providerId`。这样一次吃到 registry 的全部口径:runtime 是否启用、供应商是否已连接 /
 *      停用、条目是不是聊天模型、是否被本地停用或 retired —— 而不是去读拍平去重列表里那条
 *      可能属于别家供应商的行(规格 §2.1 / §4 明令禁止)。
 *
 * `modelId` 传归一化 id 或任一引擎的 wire id 都可以(两者等价寻址到同一行)。
 * `providerId` 传 `null` / `undefined` = 「跟随默认路由」:候选 = 该模型在该 agent 下**存在
 * 任何可路由来源**的 agent。
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
    // providerId 缺席时没有单一 provider 可查 wire id,逐个可能来源试。
    const wireIds = providerId
      ? [resolveWireModelId(providers.find((p) => p.id === providerId), modelId, agent)]
      : providers.map((provider) => resolveWireModelId(provider, modelId, agent));
    for (const wireId of wireIds) {
      if (!wireId) continue;
      const sourceId = resolveSourceId(providers, providerId, wireId, agent, scope);
      if (sourceId === null) continue;
      if (!providerId || sourceId === providerId) return true;
    }
    return false;
  });
}

/**
 * **原生底座(native agent)** —— 这个模型"生来跑在哪个引擎上",与候选集**无关**。
 *
 * 与推荐引擎的区别:推荐必须落在候选内(可选才推),原生底座是模型的固有属性 ——
 * Claude 模型即便能经 anthropic-messages bridge 在 codex 下跑,原生底座仍是 claude-code。
 * 排序用它:codex 会话优先展示 GPT 系,claude 会话优先展示 Claude 系,兼容行往下排
 * (`sortEntriesForAgent`)。
 *
 * **null = 无主场**(Chris 2026-08-13 裁决):多 root 全能模型(xai)、BYOM 与判不出的
 * 一律 null —— 不是"未知待回落",而是明确的"全场平等":任何引擎视图都不降级
 * (`partitionEntriesByNativeAgent` 只降级「主场明确在别处」的行)。推荐引擎照常由
 * `pickRecommendedAgent` 的候选回落链兜底,不受影响。
 *
 * 取值来源:内置 root 表(只标确有主场的)→ 折扣条目判 codex → **厂商家族**
 * (`groupOf`:anthropic 家族 → claude-code,gpt 家族 → codex)→ null。
 *
 * 家族这一层是 2026-08-14 补的:主场是**按模型**说的,不随来源变 —— 网关上的
 * `claude-opus-5` 主场仍是 claude-code,`gpt-5.6-luna` 主场仍是 codex。没有这一层,
 * 网关行全部落 null,推荐只能走「候选里 cc 优先」的回落链,产出两类批量错配:
 * GPT 非折扣行整列显示「底座 Claude」;cc 一旦掉出候选(运行时探测抖动 / 远端不带
 * cc),Claude 行整列翻成 Codex(Chris 实测「很吓人」的那个现象)。判定复用
 * classification 的既有分类(目录 `group` 优先、id 前缀兜底),**纯条目数据**,不碰
 * `routing.authStrategy` —— device-link 投影两端同结果的不变量保持。grok / 国产 /
 * BYOM 判不出家族的仍落 null(grok 三栖不许被硬派主场,裁决不变)。服务端目录未来
 * 按条目下发 nativeAgent 字段时,以数据覆盖此推导。
 */
export function nativeAgentForProviderModel(
  provider: Provider | ProviderView | undefined,
  modelId: string,
): AgentKind | null {
  if (!provider) return null;
  const builtin = BUILTIN_ROOT_PREFERENCE.get(provider.id);
  if (builtin) return builtin;
  // 折扣路由条目(`codex/` 前缀或服务端显式 `group:'gpt-budget'`)天生属于 Codex 侧。
  // 这个判定**只看条目数据**(device-link 投影会剥掉 routing.authStrategy,执行细节
  // 不出被控端 —— providerListProjection 测试锁,2026-08-13 远程会话实测)。
  const probe =
    findCatalogModel(provider, modelId, 'codex') ??
    findCatalogModel(provider, modelId, 'claude-code') ??
    findCatalogModel(provider, modelId, 'pi');
  const normalizedId = normalizeModelIdForClassification(modelId);
  const budget = probe
    ? isBudgetModel({
        id: normalizedId,
        ...(probe.group !== undefined ? { group: probe.group } : {}),
      })
    : isBudgetModel({ id: normalizedId });
  if (budget) return 'codex';
  // 厂商家族(见函数头):目录 group 优先、id 前缀兜底,与徽章/分组同一份判定,不另造。
  const family = groupOf({
    id: normalizedId,
    ...(probe?.group !== undefined ? { group: probe.group } : {}),
  });
  if (family === 'anthropic') return 'claude-code';
  if (family === 'gpt' || family === 'gpt-budget') return 'codex';
  return null;
}

/**
 * 在给定候选集里挑推荐引擎 —— 推导规则的**单点实现**(公开出来供联合列表与调用方复用,
 * 保证「行上显示的推荐」与「单独查的推荐」永远同一份逻辑)。
 *
 * 1. 无候选 → null(没有可推荐的东西,不编);
 * 2. 单候选 → 即它(pi 唯一候选时也推荐 pi);
 * 3. 原生底座命中候选 → 用它;
 * 4. 回落:候选里按 cc > codex 取第一个;都没有则 pi。
 *
 * 约束 2(推荐必是候选)由 3、4 共同保证:原生底座不是候选就一定回落。
 */
export function pickRecommendedAgent(
  provider: Provider | ProviderView | undefined,
  modelId: string,
  candidates: readonly AgentKind[],
): AgentKind | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const native = nativeAgentForProviderModel(provider, modelId);
  if (native && candidates.includes(native)) return native;
  const fallback = UNIFIED_AGENT_PRIORITY.find(
    (agent) => agent !== NEVER_RECOMMENDED_UNLESS_SOLE && candidates.includes(agent),
  );
  return fallback ?? (candidates.includes(NEVER_RECOMMENDED_UNLESS_SOLE) ? 'pi' : null);
}

/**
 * 该 (provider, model) 的**推荐引擎**。候选先按 `candidateAgentsForModel` 解析生效来源
 * 得出,再走 `pickRecommendedAgent`。无任何候选时返回 `null`。
 */
export function recommendedAgentForModel(
  providers: readonly ProviderView[],
  providerId: string | null | undefined,
  modelId: string,
  opts: CandidateAgentsOptions = {},
): AgentKind | null {
  const candidates = candidateAgentsForModel(providers, providerId, modelId, opts);
  if (candidates.length === 0) return null;
  const provider = providerId
    ? providers.find((entry) => entry.id === providerId)
    : // providerId 缺席(跟随默认路由)时,按**最高优先候选引擎**下解析出的默认来源判:
      // 那正是用户不显式选源时真会路由过去的那家。
      providers.find((candidateProvider) => {
        const wireId = resolveWireModelId(candidateProvider, modelId, candidates[0]);
        if (!wireId) return false;
        return (
          resolveSourceId(providers, null, wireId, candidates[0], opts.scope ?? 'draft') ===
          candidateProvider.id
        );
      });
  return pickRecommendedAgent(provider, modelId, candidates);
}

/** 某 (provider, model, agent) 已解析的能力(规格 §2.2)。 */
export interface UnifiedAgentCapability {
  agent: AgentKind;
  /**
   * ★该引擎下真正要发出去的 model id(bridge 壳已还原)。写 draft / 建会话 / 切模型
   * 一律用它,不要用行的归一化 `modelId`。
   */
  wireModelId: string;
  /** 该 (provider, agent) 条目声明的思考档;空数组 = 不可调。 */
  efforts: readonly Effort[];
  /**
   * 默认思考档,**已应用缺省回落**:目录没声明(或声明了 null / 非法值)时,只要
   * `efforts` 含 `medium` 就回落 `medium`(Chris 2026-08-13 裁决「一般默认 medium」);
   * `efforts` 为空或不含 medium 则保持 null。`defaultEffortSource` 标明这一档的来历。
   *
   * ⚠️ 调用方必须把**本字段**传给 `effortResolution.resolveEffort` 的 `defaultEffort`:
   * 那个共享函数自己的兜底仍是 `efforts[0]`(全仓历史语义,本次不动),不传就会
   * 「面板显示 medium、实际落 low」。
   */
  defaultEffort: Effort | null;
  defaultEffortSource: 'catalog' | 'fallback-medium' | 'none';
  /**
   * 该 (provider, agent, model) 的 Fast 能力 —— 走 `modelSupportsFastMode` 现查。
   * **不含 agent 运行时的粗粒度 gate**(`capabilities.hasFastMode`):那是 host 侧运行期
   * 事实,本包拿不到,由渲染层叠加(registry.ts 明示)。
   */
  supportsFastMode: boolean;
  /** 该 (provider, agent) 下的上下文窗口(同 id 跨 agent 可不同,如 gpt-5.5 cc=1M / codex=272K)。 */
  contextWindow: number;
  /** 该窗口是否为显式声明的真实上限(`CatalogModel.contextWindowVerified`)。 */
  contextWindowVerified: boolean;
}

/** 默认档缺省回落:目录没给(或给了 null / 非法值)时,efforts 含 medium 就落 medium。 */
function resolveDefaultEffort(model: CatalogModel): {
  defaultEffort: Effort | null;
  defaultEffortSource: UnifiedAgentCapability['defaultEffortSource'];
} {
  const declared = model.defaultEffort;
  if (declared !== null && declared !== undefined && model.efforts.includes(declared)) {
    return { defaultEffort: declared, defaultEffortSource: 'catalog' };
  }
  if (model.efforts.includes('medium')) {
    return { defaultEffort: 'medium', defaultEffortSource: 'fallback-medium' };
  }
  return { defaultEffort: null, defaultEffortSource: 'none' };
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
    wireModelId: model.id,
    efforts: model.efforts,
    ...resolveDefaultEffort(model),
    // 按目录里真实那条 id 查 Fast,避免归一命中后误报 false。
    supportsFastMode: modelSupportsFastMode(provider, model.id, agent),
    contextWindow: model.contextWindow,
    contextWindowVerified: model.contextWindowVerified === true,
  };
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

/** 联合列表的一行:一个逻辑模型 (provider, 归一化 modelId),横跨它能用的所有引擎。 */
export interface UnifiedModelEntry {
  providerId: string;
  /** ★**归一化 id**(行的稳定身份 / override / 收藏 key)。发请求请用 `capabilities[agent].wireModelId`。 */
  modelId: string;
  /** 展示名 —— 取**推荐引擎**那条目录条目(同 id 跨 agent 元数据可不同)。 */
  displayName: string;
  description?: string;
  /** 分组 / 排序:面板右栏按服务端下发的 group + sortOrder 陈列(规格 §1.2)。 */
  group?: string;
  sortOrder?: number;
  /** 展示图标 id(`CatalogModel.icon`;缺省由渲染层回落供应商标)。 */
  icon?: string;
  /** 候选引擎,按 `UNIFIED_AGENT_PRIORITY` 序。恒 ≥1。 */
  candidates: AgentKind[];
  /** 推荐引擎,恒 ∈ candidates。 */
  recommended: AgentKind;
  /**
   * ★**原生底座**:这个模型生来属于哪个引擎,**不与候选求交**(Claude 模型即便 codex 可跑,
   * native 仍是 claude-code)。会话内「同引擎视图」按它排序(`sortEntriesForAgent`)。
   * **null = 无主场**(多 root 全能模型 / BYOM):任何引擎视图都不降级,详见
   * `nativeAgentForProviderModel` 头注(Chris 2026-08-13 裁决)。
   */
  nativeAgent: AgentKind | null;
  /** 逐候选引擎已解析的能力。键集 = candidates。 */
  capabilities: Partial<Record<AgentKind, UnifiedAgentCapability>>;
}

export interface UnifiedModelEntriesOptions {
  providers: readonly ProviderView[];
  /** 参与联合的引擎;缺省 = 全部三个。 */
  agents?: readonly AgentKind[];
  /**
   * 可见性谓词(用户「设置 → 模型供应商」的显隐 override)。带 `agent` 维度 —— 显隐 key
   * 是 `<agent>:<providerId>:<modelId>`(见 renderer `isDeviceModelVisible`),同 id 在
   * cc / codex 下可以一显一隐。缺省 = 不过滤。
   *
   * 注意:传进来的 `model` 是**该引擎下的目录条目**(wire id 形态),不是行的归一化 id。
   */
  isVisible?: (providerId: string, model: CatalogModel, agent: AgentKind) => boolean;
  /** 整供应商排除(SSH 远程排除 chat-bridged Codex 源等)。 */
  excludeProvider?: (provider: ProviderView, agent: AgentKind) => boolean;
  /** 单模型排除(SSH 远程排除订阅直连前缀等)。 */
  excludeModel?: (model: CatalogModel, provider: ProviderView, agent: AgentKind) => boolean;
  /** 来源解析口径,默认 `'draft'`。 */
  scope?: SourceResolutionScope;
  /**
   * **选中行豁免**(`deriveModelList.keepSelected` 的联合列表版,同一条既有约定):
   * 这一 (来源, wire id) 即便被 `disabled` / `status:'retired'` / 可见性 override 挡住,
   * 也必须留在列表里。
   *
   * 为什么必须有:`scope:'session'` 只作用于**来源解析**那一步,枚举阶段仍走
   * `isModelSelectableForNewRoute`(新路由准入)——于是一个运行中会话选中的模型被服务端
   * 下架或被用户停用后,那一行会从面板里凭空消失:选择器打开是空选态,用户看不出自己
   * 正在跑什么,更换不回来。
   *
   * ⚠️ **`agent` 必填,豁免只覆盖这一个引擎**(2026-08-17 review 修正)。豁免的语义是
   * 「让用户看见并保住**当前正在跑的那份运行配置**」,当前 agent 一定是已知的。早先按
   * **整行**豁免有真实的越权:同一 (来源, 模型) 在别的引擎下还有目录副本时,那些副本
   * 即便已 retired / 停用 / 解析不回本行来源,也会一并跳过校验变成可点候选 —— 用户在
   * 浮层里把行切过去,要么路由到另一条来源,要么直接发不出去(正是「不做假按钮」要挡的)。
   * 现在:**只有 `agent` 这一格**跳过枚举准入与来源校验,同一行的其它引擎照常走全部校验,
   * 不合格就不进 `candidates`(`capabilities` 键集 = `candidates` 的不变量因此保持)。
   *
   * `providerId` 传 `null` = 按 wire id 匹配任意来源(跟随默认路由的选中态)。
   * 被豁免的那一格仍要能从目录里解析出能力才成行;整行一个候选都没有时才丢弃。
   *
   * `modelId` 必须是 **`agent` 这一格的 wire id**(= 会话 / 草稿里存着的那个 id),不是行的
   * 归一化身份:豁免要在 `agent` 自己的目录列表上命中才生效。调用方本来就存的是它。
   *
   * 豁免覆盖**三层**过滤(2026-08-17 review:此前只够到后两层,供应商被停用 / 断开时行在
   * rail 层就没了):
   *   1. 供应商层 —— kept 供应商被 `connected-for-agent` 整家剔除(suspended / offline)时
   *      并回枚举,且并回来源上只放行点名 wire id(见枚举循环内注释);
   *   2. 模型层 —— disabled / retired / 隐藏,借 `deriveModelList.keepSelected`;
   *   3. 引擎层 —— 生效来源校验,仅 `agent` 那一格跳过。
   * runtime 级 disabled(目录声明该引擎不可路由)仍不豁免:那不是暂时不可用,是从来
   * 路由不到。
   */
  keepModel?: { providerId: string | null; modelId: string; agent: AgentKind };
}

function entryKey(providerId: string, keyModelId: string): string {
  return `${providerId} ${keyModelId}`;
}

/**
 * 跨引擎联合列表 —— 统一选择器面板的行数据源(规格 §1.2 / §2.1)。
 *
 * 形状:每个可见**逻辑模型** `(provider, 归一化 id)` 一行,行上带候选引擎、推荐引擎、
 * 原生底座与逐引擎能力(含各自 wire id)。与旧版「先选引擎再选模型」的分面清单是两种形状:
 * 旧版 `selectVisibleModels` 把三份清单按 model id 首见去重合并成一列(丢掉来源与另一引擎
 * 的能力);本函数按 (provider, 归一化 id) 聚合,同名模型多来源各出一行。
 *
 * 顺序契约:引擎按 `UNIFIED_AGENT_PRIORITY` 外层遍历,每个引擎内按标准派生序(供应商 rail
 * 序 = catalog 序,供应商内目录序);行的位置由它**首次出现**的引擎决定。展示分组/排序另走
 * `groupModelsForDisplay` / `sortEntriesForAgent`,本函数**不二次排序**。
 *
 * 准入:复用 `deriveModelList` 的标准派生(非聊天模型 / `disabled` / `retired` 内建过滤),
 * 再叠一层「生效来源必须就是本行来源」的校验。空候选的行整行丢弃。`keepModel` 点名的那一行
 * **只在 `keepModel.agent` 那一格**豁免这两道,同行的其它引擎照常受校验(见该选项头注)。
 *
 * 供应商范围固定 `'connected-for-agent'`:第二道来源校验本就只认已连接来源
 * (`effectiveSourceIdForModel` / `actualSourceIdForModel` 都过 `chatEligibleSourcesForModel`
 * 的 `onlyConnected`),放宽枚举范围只会枚举出一批随后必被丢弃的行 —— 故不给调用方开这个口。
 * 唯一的内建例外是 `keepModel`:kept 供应商被该 rail 整家剔除(用户停用 / 来源断开)时,
 * 仅 kept agent 那一轮把它并回,且并回来源上只放行点名的 wire id(见循环内注释)——
 * 豁免范围仍收在「点名模型 × kept 引擎」,不是把 rail 对整家打开。
 */
export function unifiedModelEntries(opts: UnifiedModelEntriesOptions): UnifiedModelEntry[] {
  const {
    providers,
    agents,
    isVisible,
    excludeProvider,
    excludeModel,
    scope = 'draft',
    keepModel,
  } = opts;

  const activeAgents = UNIFIED_AGENT_PRIORITY.filter(
    (agent) => agents === undefined || agents.includes(agent),
  );

  interface Draft {
    providerId: string;
    keyModelId: string;
    /** 该行在各引擎下被枚举到的 wire id。 */
    wireIds: Partial<Record<AgentKind, string>>;
    agents: AgentKind[];
    /**
     * 这一行是 `keepModel` 点名的选中行 → **仅 `keepModel.agent` 那一格**豁免新路由准入
     * (见该选项头注:整行豁免会把别的引擎上已不可路由的目录副本一起放行)。
     */
    kept: boolean;
  }
  const drafts = new Map<string, Draft>();
  const order: string[] = [];

  // kept 判定**绑定枚举引擎**(2026-08-17 review):keepModel.modelId 是 kept agent 自己的
  // wire id,只允许在 kept agent 那一轮、由它自己的行点亮。不绑 agent 时,别的引擎恰好有一条
  // id 与之相等的目录条目(桥接壳 / 撞名商品)就会把同一逻辑行标成 kept,随后 keptAgent 让
  // kept agent 那一格跳过来源校验 —— 而那一格的 wire id 从未匹配过当前配置,providerId 为
  // null(跟随默认路由)的会话尤其容易放进来一个点了会改道或失败的错来源候选。
  const isKeptRow = (agent: AgentKind, providerId: string, wireId: string): boolean =>
    keepModel !== undefined &&
    keepModel.agent === agent &&
    keepModel.modelId === wireId &&
    (keepModel.providerId === null || keepModel.providerId === providerId);

  for (const agent of activeAgents) {
    // rail 并回(2026-08-17 review):kept 供应商被 `connected-for-agent` 整家剔除(用户
    // 停用 suspended / 来源断开 offline)时,当前模型行在**供应商层**就消失了,`keepSelected`
    // 在模型层再点名也无从豁免 —— 运行中会话的用户看不见自己正在跑什么。仅 kept agent
    // 这一轮把该供应商并回枚举范围(按原目录序过滤,不破坏 rail 序契约),并回来源上只放行
    // 点名的那一个 wire id(其余模型不因此变成新路由候选);同行其它引擎的格子照常走来源
    // 校验(suspended / offline 来源解析不回本行,自然出局)。providerId 为 null(跟随默认
    // 路由)时只在**没有任何已连接来源提供该 wire id** 时才并回 —— 有健康来源时行本就在,
    // 再并回一家停用来源只会多出一条点了会改道的影子行。runtime 级 disabled(目录 routing
    // 声明该引擎不可路由)不并回:那不是「暂时不可用」而是「从来路由不到」,并回也发不出去。
    let keptRail: readonly ProviderView[] | null = null;
    let restrictRejoined: ((model: CatalogModel, provider: ProviderView) => boolean) | null =
      null;
    if (keepModel !== undefined && keepModel.agent === agent) {
      const connectedIds = new Set(
        connectedProvidersForAgent([...providers], agent).map((p) => p.id),
      );
      const rejoined = providersForAgent([...providers], agent).filter(
        (p) =>
          !connectedIds.has(p.id) &&
          (keepModel.providerId !== null
            ? p.id === keepModel.providerId
            : providerOffersModel(p, keepModel.modelId, agent) &&
              !providers.some(
                (c) => connectedIds.has(c.id) && providerOffersModel(c, keepModel.modelId, agent),
              )),
      );
      if (rejoined.length > 0) {
        const rejoinedIds = new Set(rejoined.map((p) => p.id));
        const keptWireId = keepModel.modelId;
        keptRail = providers.filter((p) => connectedIds.has(p.id) || rejoinedIds.has(p.id));
        restrictRejoined = (model, provider) =>
          rejoinedIds.has(provider.id) && model.id !== keptWireId;
      }
    }
    const rows = deriveModelList({
      providers: keptRail ?? providers,
      agent,
      // 并回生效时改走 'as-given':keptRail 已按「原 rail ∪ kept 供应商」收窄并保持目录序,
      // 再套 connected 过滤会把刚并回的那家立刻剔掉。
      providerScope: keptRail ? 'as-given' : 'connected-for-agent',
      // 同 id 多来源必须各出一行:联合列表按 (provider, 模型) 聚合,拍平去重会把另一来源
      // 的能力/徽章张冠李戴(规格 §4「同名模型多来源」)。
      dedupe: 'none',
      ...(isVisible ? { isVisible: (pid, model) => isVisible(pid, model, agent) } : {}),
      ...(excludeProvider
        ? { excludeProvider: (provider) => excludeProvider(provider, agent) }
        : {}),
      ...(excludeModel || restrictRejoined
        ? {
            excludeModel: (model: CatalogModel, provider: ProviderView) =>
              (restrictRejoined !== null && restrictRejoined(model, provider)) ||
              (excludeModel !== undefined && excludeModel(model, provider, agent)),
          }
        : {}),
      // 选中行豁免直接借 deriveModelList 的既有 keepSelected:它同时松开可见性 override 与
      // 「新路由准入」(改用 isAgentSelectableModel),正是 disabled / retired 选中行要的那两道。
      // **只在 kept agent 这一轮传**:别的引擎上的同 id 副本必须照常受准入约束,否则一条
      // retired 的 bridge 副本会跟着混进候选(见 keepModel 头注)。
      ...(keepModel && keepModel.agent === agent
        ? { keepSelected: { providerId: keepModel.providerId, modelId: keepModel.modelId } }
        : {}),
    });
    for (const row of rows) {
      const keyModelId = unifiedModelKeyId(row.id);
      const key = entryKey(row.sourceProviderId, keyModelId);
      const kept = isKeptRow(agent, row.sourceProviderId, row.id);
      const hit = drafts.get(key);
      if (hit) {
        if (!hit.agents.includes(agent)) hit.agents.push(agent);
        // 同一 (引擎, 供应商, 归一化 id) 只可能来自一条目录条目 —— dedupe:'none' 下同一份
        // provider.models[agent] 里出现两条归一后同 key 的 id(如 `x` 与 `chatgpt/x` 同时
        // 在场)才会撞行。撞了取**先出现**的那条,与 deriveModelList 的目录序契约一致:
        // 后面那条只是同一逻辑模型的另一个壳,壳的选取不该改变行的身份。
        if (hit.wireIds[agent] === undefined) hit.wireIds[agent] = row.id;
        if (kept) hit.kept = true;
        continue;
      }
      drafts.set(key, {
        providerId: row.sourceProviderId,
        keyModelId,
        wireIds: { [agent]: row.id },
        agents: [agent],
        kept,
      });
      order.push(key);
    }
  }

  const out: UnifiedModelEntry[] = [];
  for (const key of order) {
    const draft = drafts.get(key);
    if (!draft) continue;
    const provider = providers.find((entry) => entry.id === draft.providerId);
    if (!provider) continue;
    // 候选与能力**一次求齐**,保证「capabilities 键集 = candidates」这条不变量成立:
    //   1. 校验用枚举时记下的**该引擎自己的 wire id**(不是行的归一化 id)—— 归一化 id 在
    //      bridge 引擎的目录里根本不存在,拿它重查会把校验做成一次运气;
    //   2. 解析生效来源:必须解析回本行来源(约束 1)。**只有 `keepModel.agent` 那一格**
    //      跳过这一步(它可能已被停用 / 下架,新路由准入本就会拒;但当前跑着的那一格必须
    //      留着能看见)。同一行的其它引擎照常校验 —— 那些格子是「换过去」的候选,不是
    //      「正在跑」的事实,放行等于给一个点了会路由错来源或直接失败的胶囊;
    //   3. 目录条目解析不出能力的引擎一律剔除 —— 宁可少一个胶囊,不做点了发不出去的假按钮。
    //      kept 那一格同样按这条走(不另开兜底):它的 wire id 就是刚从该引擎自己的目录列表
    //      里枚举出来的,`capabilityOf` 拿同一个 id 精确回查恒命中;真解析不出说明目录自相
    //      矛盾,此时宁可整行落空也不合成一份能力未知的假配置。
    const candidates: AgentKind[] = [];
    const capabilities: Partial<Record<AgentKind, UnifiedAgentCapability>> = {};
    for (const agent of UNIFIED_AGENT_PRIORITY) {
      if (!draft.agents.includes(agent)) continue;
      const wireId = draft.wireIds[agent];
      if (wireId === undefined) continue;
      const keptAgent = draft.kept && keepModel?.agent === agent;
      if (!keptAgent) {
        const sourceId = resolveSourceId(providers, draft.providerId, wireId, agent, scope);
        if (sourceId !== draft.providerId) continue;
      }
      const capability = capabilityOf(provider, wireId, agent);
      if (!capability) continue;
      candidates.push(agent);
      capabilities[agent] = capability;
    }
    if (candidates.length === 0) continue;
    const recommended = pickRecommendedAgent(provider, draft.keyModelId, candidates);
    if (recommended === null) continue;
    // 展示元数据取推荐引擎那条(同 id 跨 agent 元数据可不同)。推荐必在候选内,而候选的
    // wire id 与能力上面已经解析成功,所以这一查恒命中 —— 不再写第二层回落。
    const display = findCatalogModel(provider, draft.wireIds[recommended]!, recommended);
    out.push({
      providerId: draft.providerId,
      modelId: draft.keyModelId,
      displayName: display?.name ?? draft.keyModelId,
      ...(display?.description !== undefined ? { description: display.description } : {}),
      ...(display?.group !== undefined ? { group: display.group } : {}),
      ...(display?.sortOrder !== undefined ? { sortOrder: display.sortOrder } : {}),
      ...(display?.icon !== undefined ? { icon: display.icon } : {}),
      candidates,
      recommended,
      nativeAgent: nativeAgentForProviderModel(provider, draft.keyModelId),
      capabilities,
    });
  }
  return out;
}

/**
 * 按**原生底座**把行分成两组(会话内「同引擎视图」的排序依据,Chris 2026-08-13 裁决):
 * codex 会话优先展示 GPT 系,claude 会话优先展示 Claude 系;只是"兼容能跑"的往下排。
 *
 * **只降级「主场明确在别处」的行**:`nativeAgent === null`(无主场 —— 多 root 全能模型 /
 * BYOM)留在上组,与原生行按入参序混排 —— 上游给 grok 这类三栖模型硬选一个主场再也不会
 * 把它在其余引擎视图错误降级(同日裁决,与 `nativeAgentForProviderModel` 头注同源)。
 *
 * 两组内部**保持入参顺序**(= 服务端 group / sortOrder 的陈列序)。调用方若要再做分组
 * 展示(`groupModelsForDisplay`),应**分别在两组内**做,不要先分组再排序 —— 那会把
 * 原生优先的分割打散。
 */
export function partitionEntriesByNativeAgent(
  entries: readonly UnifiedModelEntry[],
  targetAgent: AgentKind,
): { native: UnifiedModelEntry[]; compatible: UnifiedModelEntry[] } {
  const native: UnifiedModelEntry[] = [];
  const compatible: UnifiedModelEntry[] = [];
  for (const entry of entries) {
    const guestElsewhere = entry.nativeAgent !== null && entry.nativeAgent !== targetAgent;
    (guestElsewhere ? compatible : native).push(entry);
  }
  return { native, compatible };
}

/**
 * `partitionEntriesByNativeAgent` 的拍平形态:原生底座 == 目标引擎的行在前,兼容行在后,
 * 组内稳定(不改变入参相对序)。
 *
 * 注意:本函数**不过滤**候选 —— 「完全不兼容目标引擎的行不显示」由调用方在派生阶段用
 * `agents: [targetAgent]`(或按 `candidates.includes(targetAgent)`)完成,那是准入不是排序。
 */
export function sortEntriesForAgent(
  entries: readonly UnifiedModelEntry[],
  targetAgent: AgentKind,
): UnifiedModelEntry[] {
  const { native, compatible } = partitionEntriesByNativeAgent(entries, targetAgent);
  return [...native, ...compatible];
}
