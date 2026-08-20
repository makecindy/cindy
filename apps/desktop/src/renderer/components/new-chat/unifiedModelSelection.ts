/**
 * unifiedModelSelection —— 统一模型选择器(模型优先)面板的**纯逻辑层**:行生效配置合成、
 * 收藏/分组陈列、rail 派生、配置浮层定位。规格见
 * `docs/product-rules/model-selector-unified.md` §1.2 / §1.3 / §1.5 / §2。
 *
 * 为什么单独一层:M3 的行三元组(引擎图标 + 推理强度 + Fast)与 M4 浮层里的每一个控件,
 * 显示的都是**同一份合成结果** —— 推荐引擎(M1 纯逻辑) ⊕ 引擎 override(M2 store) ⊕
 * providerModelMemory 的既有深度 / Fast 槽。合成规则若在行与浮层各写一遍,必然漂移成
 * 「行上写着 high、浮层滑杆停在 medium」。这里是那份规则的单点实现,组件只负责画。
 *
 * 三条边界:
 *   1. **零 IO**:store 的读取(引擎 override / 收藏 / 记忆)由调用方注入取值函数,本模块
 *      不 import 任何 store —— 同一套规则要能在 jsdom 之外直接单测。
 *   2. **推荐永远来自 M1**:本模块不自己推导推荐引擎,只消费 `UnifiedModelEntry.recommended`
 *      与 `capabilities`(它们已按生效来源解析,禁止读拍平列表 —— 见 unifiedSelection 头注)。
 *   3. **深度只存 canonical key**:`Effort` 全程是 `EFFORT_VALUES` 里的键,显示文案另查
 *      (i18n `effortLevels.*`),绝不把翻译过的文案回灌进配置。
 */

import type { UnifiedAgentCapability, UnifiedModelEntry } from '@cindy/model-providers';
import { sortEntriesForAgent } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { SelectableVendor } from '@/lib/agentVendors';
import type { Effort } from '@/lib/userPreferences.types';
import { applyProviderOrderIds } from '../../../shared/providerOrder';
import type { ModelFavoriteItem } from '@/state/modelFavorites';

/** 引擎在**选择器 / 草稿链路**里的口径(vendor);catalog / capabilities 侧是 AgentKind。 */
export type UnifiedEngine = SelectableVendor;

/** vendor → AgentKind(查目录 / 能力 / 记忆时用)。 */
export function agentKindOfEngine(engine: UnifiedEngine): AgentKind {
  return engine === 'cc' ? 'claude-code' : engine === 'codex' ? 'codex' : 'pi';
}

/** AgentKind → vendor(落 store / draft 时用)。未知值回落 cc,与既有 sanitize 方向一致。 */
export function engineOfAgentKind(agent: AgentKind): UnifiedEngine {
  return agent === 'codex' ? 'codex' : agent === 'pi' ? 'pi' : 'cc';
}

/**
 * 行 / 浮层的锚点(规格 §1.5):模型行按 (来源, 模型) 定位,收藏条目按**独立 uid** 定位。
 * 同模型的多条收藏互不牵连,靠的就是这个 uid —— 选中 / hover / 浮层绑定 / 删除全走锚点。
 */
export type UnifiedAnchor =
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'fav'; uid: string; providerId: string; modelId: string };

/** 锚点的字符串键(React key / DOM data 属性 / 相等比较)。 */
export function anchorKey(anchor: UnifiedAnchor): string {
  return anchor.kind === 'fav'
    ? `fav::${anchor.uid}`
    : `model::${anchor.providerId}::${anchor.modelId}`;
}

export function sameAnchor(a: UnifiedAnchor | null, b: UnifiedAnchor | null): boolean {
  if (!a || !b) return a === b;
  return anchorKey(a) === anchorKey(b);
}

/**
 * 该行在某引擎下要发出去的 wire id;查不到回落行 id(归一化 id)。
 * 所有「发出去」与「按 wire id 存取既有表」的路径都从这里取,不要各自 `capabilities[x]?.…`。
 */
export function wireModelIdOf(entry: UnifiedModelEntry, agent: AgentKind): string {
  return entry.capabilities[agent]?.wireModelId ?? entry.modelId;
}

/**
 * 外部给的 model id 是不是**这一行**。
 *
 * 合并行之后这条判定必须两头都认:会话 / 草稿里存的是**wire id**(如 `codex/gpt-5.5`),
 * 而行身份、收藏与引擎 override 用的是**归一化 id**(`gpt-5.5`)。只比一边,会出现
 * 「选中的模型在列表里不高亮」或「老收藏整条消失」。
 */
export function entryMatchesModelId(
  entry: UnifiedModelEntry,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (entry.modelId === modelId) return true;
  return Object.values(entry.capabilities).some(
    (capability) => capability?.wireModelId === modelId,
  );
}

/** 一行(或一条收藏)当前**生效**的完整配置。 */
export interface UnifiedRowConfig {
  engine: UnifiedEngine;
  agent: AgentKind;
  /** 该 (模型, 引擎) 真实支持的档位;**空数组 = 不可调**(浮层不画滑杆,行不显示档字)。 */
  efforts: readonly Effort[];
  /** 生效档位;不可调时为 null。 */
  effort: Effort | null;
  /** 生效的 Fast 开关(不具备能力时恒 false —— 不做假按钮)。 */
  fast: boolean;
  /** 该 (模型, 引擎) 是否真的支持 Fast(目录能力 × agent 运行时能力)。 */
  fastCapable: boolean;
  /** 用户是否在这一行上留下过与推荐不同的配置(行内三元组提亮 / 浮层底栏三态)。 */
  customized: boolean;
  capability: UnifiedAgentCapability | null;
  /**
   * ★该 (行, 生效引擎) **真正要发出去的 wire model id**。
   *
   * 行身份(`entry.modelId`)是**归一化 id**:同一个逻辑模型在 cc / codex 下可能是
   * `gpt-5.5` 与 `codex/gpt-5.5` 两条不同的目录条目,合并成一行后,行 id 只用来做
   * 稳定身份(anchor / 引擎 override key / 收藏 key)。凡是「发出去」或「与既有按 wire id
   * 存取的表打交道」的路径 —— 建会话、写 draft、providerModelMemory 的深度 / Fast 槽、
   * 价格查询 —— 一律用这个字段。混用会造出「界面显示 A、发出去 B」或把归一化 id 写进
   * 记忆表污染既有消费方。
   *
   * 目录里查不到该引擎条目时为 null(理论上不该发生:引擎在候选里就一定有条目),
   * 调用方回落行 id。
   */
  wireModelId: string | null;
}

export interface ResolveRowConfigArgs {
  entry: UnifiedModelEntry;
  /** 用户显式选定的引擎(modelEnginePrefs);不在候选内视同没有(推荐必须是候选)。 */
  engineOverride?: UnifiedEngine | undefined;
  /** 该 (agent, 来源, 模型) 的深度记忆(providerModelMemory 既有槽)。 */
  memoryEffort?: (agent: AgentKind) => Effort | undefined;
  /** 该 (agent, 来源, 模型) 的 Fast 记忆(providerModelMemory 既有槽)。 */
  memoryFast?: (agent: AgentKind) => boolean | undefined;
  /** agent 运行时是否具备 Fast 能力(useAgentCapabilities.hasFastMode);缺省视为具备。 */
  agentFastModeCapable?: (agent: AgentKind) => boolean;
  /**
   * 会话内的**默认落点引擎**(= 当前会话正在跑的引擎,规格 §1.6)。命中候选时**顶替推荐**
   * 作为该行的缺省引擎 —— 会话内切引擎是有损的,一个两边都能跑的模型应当默认落在当前引擎上
   * (无损直切),而不是按"新会话推荐"把用户推去重建上下文。
   *
   * 优先级刻意排在**用户显式 override 之下**:用户在浮层里点过引擎胶囊,那是显式意图,
   * 会话内也要照显示(此时该行就是一次跨引擎选择,由调用方走 performAgentSwitch)。
   * 把 pinned 排在 override 之上会造出「点了没反应」的假按钮。
   *
   * **只对「无主场」或「主场就是当前引擎」的行生效**(2026-08-14,Chris 实测反馈):
   * 主场明确在别处的行(如 codex 会话里的 Claude 系)不跟随会话引擎 —— 否则打开面板
   * 满屏 Claude 模型全标着 Codex,像被批量改了配置(实际只是显示落点),而且选中它会
   * 静默骑在当前引擎的 bridge 上跑。这类行保持显示自己的主场,选中时走跨引擎切换
   * (确认 + 上下文重建的既有事务);确要"Claude 模型骑 codex"的,浮层里显式点引擎
   * 胶囊(override 仍然最高优先)。
   *
   * ★ 这里算出来的落点与 `buildUnifiedListSections` 的同引擎视图过滤是**同一条规则的两半**
   * (Chris 2026-08-19):落点不在当前引擎的行,同引擎视图里根本不显示。改一处必须改另一处,
   * 否则会重演「仅 Claude 视图里摆着一排点下去要跨引擎切换的行」。
   */
  pinnedEngine?: UnifiedEngine | undefined;
  /**
   * **强制引擎**(选中行专用):当前草稿 / 会话**实际在用**的那一行,显示必须与事实
   * 一致 —— 引擎栏、深度、Fast 全部按正在跑的引擎画,不受推荐 / override / pinned
   * 影响(override 描述的是"下次选它用什么",不能改写"现在正跑着什么")。
   * 不在候选内时忽略(理论上选中行的引擎必在候选,防御历史脏数据)。
   */
  forceEngine?: UnifiedEngine | undefined;
}

function pickEffort(
  capability: UnifiedAgentCapability | null,
  remembered: Effort | undefined,
): Effort | null {
  // 目录侧 Effort 是字面量联合、renderer 侧是 string 别名 —— 这里统一按 string 比较,
  // 免得每个 includes 都要断言;值域校验由 store 的 sanitize(EFFORT_VALUES)负责。
  const efforts: readonly string[] = capability?.efforts ?? [];
  if (efforts.length === 0) return null;
  if (remembered && efforts.includes(remembered)) return remembered;
  const fallback: string | null = capability?.defaultEffort ?? null;
  return fallback && efforts.includes(fallback) ? fallback : (efforts[0] ?? null);
}

/**
 * 模型行的生效配置 = **推荐引擎 ⊕ 引擎 override ⊕ 深度 / Fast 记忆**。
 *
 * 引擎:override 命中候选才采用 —— 候选集是「真能路由」的集合(M1 约束 2),放行一个不在
 * 候选里的历史 override 就是造假按钮(用户重启后发现选不出去)。落不到候选时静默回落推荐,
 * **不清 store**:候选可能只是当前来源没连上,连回来后用户的选择应当照旧生效。
 *
 * 深度:记忆值必须被该 (模型, 引擎) 真实支持才采用 —— 同一模型跨引擎档位集合不同
 * (如 codex 有 xhigh、cc 没有),照搬会显示一个发不出去的档。
 */
export function resolveUnifiedRowConfig(args: ResolveRowConfigArgs): UnifiedRowConfig {
  const { entry, engineOverride, memoryEffort, memoryFast, agentFastModeCapable } = args;
  const candidateEngines = entry.candidates.map(engineOfAgentKind);
  const overrideUsable =
    engineOverride !== undefined && candidateEngines.includes(engineOverride);
  const pinned =
    args.pinnedEngine !== undefined &&
    candidateEngines.includes(args.pinnedEngine) &&
    // 主场明确在别处的行不跟随会话引擎(见 pinnedEngine 注释):codex 会话里 Claude 系
    // 保持显示 claude-code 主场,选中走跨引擎切换,不静默骑 bridge。
    (entry.nativeAgent === null || engineOfAgentKind(entry.nativeAgent) === args.pinnedEngine)
      ? args.pinnedEngine
      : undefined;
  const forced =
    args.forceEngine !== undefined && candidateEngines.includes(args.forceEngine)
      ? args.forceEngine
      : undefined;
  const baseline = pinned ?? engineOfAgentKind(entry.recommended);
  const engine = forced ?? (overrideUsable ? engineOverride : baseline);
  const agent = agentKindOfEngine(engine);
  const capability = entry.capabilities[agent] ?? null;
  const effort = pickEffort(capability, memoryEffort?.(agent));
  const fastCapable =
    capability?.supportsFastMode === true && (agentFastModeCapable?.(agent) ?? true);
  const fast = fastCapable ? (memoryFast?.(agent) ?? false) : false;
  const customized =
    // 「已自定义」是相对**该行此刻的缺省**说的:会话内 pinned 生效时,落在当前引擎上
    // 是缺省而不是自定义(否则会话里几乎每一行都被标成已自定义,提亮就失去信息量)。
    // 按 override 本身(而不是 forced 后的 engine)判:选中行被强制显示 live 引擎时,
    // 用户留过的引擎选择仍应提亮。
    (overrideUsable && engineOverride !== baseline) ||
    (effort !== null && capability?.defaultEffort != null && effort !== capability.defaultEffort) ||
    fast;
  return {
    engine,
    agent,
    efforts: capability?.efforts ?? [],
    effort,
    fast,
    fastCapable,
    customized,
    capability,
    wireModelId: capability?.wireModelId ?? null,
  };
}

/**
 * 收藏条目的生效配置 —— 与模型行**不同源**:收藏是配置副本,只读条目自己存的
 * (引擎 / 深度 / Fast),不读该模型的 override 与记忆(规格 §1.5「模型默认不受影响」)。
 * 条目里存的值若已不被目录支持(引擎掉出候选 / 档位被服务端下架),按同一套回落规则收敛,
 * 但**不改写条目**:目录变回来时用户的收藏应当照旧。
 */
export function resolveFavoriteRowConfig(args: {
  entry: UnifiedModelEntry;
  item: ModelFavoriteItem;
  agentFastModeCapable?: (agent: AgentKind) => boolean;
}): UnifiedRowConfig {
  const { entry, item, agentFastModeCapable } = args;
  const candidateEngines = entry.candidates.map(engineOfAgentKind);
  const engine = candidateEngines.includes(item.agent)
    ? item.agent
    : engineOfAgentKind(entry.recommended);
  const agent = agentKindOfEngine(engine);
  const capability = entry.capabilities[agent] ?? null;
  const effort = pickEffort(capability, item.effort);
  const fastCapable =
    capability?.supportsFastMode === true && (agentFastModeCapable?.(agent) ?? true);
  const fast = fastCapable && item.fast === true;
  return {
    engine,
    agent,
    efforts: capability?.efforts ?? [],
    effort,
    fast,
    fastCapable,
    // 收藏条目恒按「收藏配置」呈现(底栏第三态),不参与「已自定义」的提亮语义。
    customized: false,
    capability,
    wireModelId: capability?.wireModelId ?? null,
  };
}

/**
 * 「当前选中的收藏」锚点的**完整配置校验**(2026-08-19 review P2:深度与 Fast 纳入锚点判定)。
 *
 * 病根:锚点记录与上游派生校验(草稿 / 会话两侧)只比模型、来源、引擎三个**身份**维。
 * 收藏的定义是**完整配置副本**(规格 §1.2,含深度与 Fast)——持久化锚点存在期间,
 * device-link seed、另一窗口或另一控制端只改同一模型/来源的 effort 或 Fast 时,身份三维
 * 照样全对,旧收藏 uid 被恢复:面板抑制真实模型行的勾选、把带旧深度/Fast 的副本当成
 * 当前配置展示,编辑/删除还会按错误副本执行(删除会误触「先回落默认配置」)。
 *
 * 修法是**校验收窄,不是记录加维**:锚点记录刻意维持身份三元组(见 favoriteAnchorMemory
 * 的 schema 注释)——把 effort/Fast 抄进锚点会造出第二份会过期的副本(编辑选中收藏的
 * 每一条路径都得记得同步它,漏一处就误杀)。这里改为在**消费点**把「该收藏当前副本的
 * 解析结果」与「正在跑的完整配置」直接比对:收藏 store 与 live 值都是各自的唯一事实源,
 * 不新增任何写路径。所有锚点入口(草稿槽、会话槽、storage 事件回读、各建会话路径的
 * 锚点携带)最终都汇到这一个派生点,天然一次覆盖。
 *
 * 逐维口径:
 * - 引擎:`liveAgent` 已知时必须与副本解析引擎一致(意图期 = 目标引擎,与调用方
 *   liveEngineAgent 同口径);未知(身份未加载的一帧)不参与判定,免得误杀。
 * - 深度:双方都有值才比 —— 副本解析出 null(不可调模型)或 live 值为空(上游未就绪)
 *   时该维放行。
 * - Fast:live 值按副本的 fastCapable 门控后逐字比(副本无能力时恒 false,两边同规则)。
 * - 收藏指向的模型行不可路由(来源断开)时**不否决**:配置无从解析,身份校验已在上游
 *   通过,此时列表里本就没有可勾的行,维持既有行为。
 *
 * 面板内正常操作不会被误杀:模型行上改 live 深度/Fast 会显式清锚(M2),编辑选中收藏
 * 走「live 写成才落副本」的同一事务(两边同步收敛);只有**外部**改动才会造成真正的
 * 副本 ≠ live,而那正是该松开勾选的时刻。
 */
export function resolveActiveFavoriteAnchorUid(args: {
  /** 上游身份校验(模型/来源/引擎快照)已通过的锚点 uid。 */
  selectedFavoriteUid: string | null | undefined;
  favorites: readonly ModelFavoriteItem[];
  entries: readonly UnifiedModelEntry[];
  /** 正在跑的深度(空值 = 未知,该维不参与判定)。 */
  liveEffort: Effort | null | undefined;
  /** 正在跑的 Fast。 */
  liveFast: boolean;
  /** 正在跑的引擎(意图期 = 目标引擎);null = 身份未加载,该维不参与判定。 */
  liveAgent: AgentKind | null;
  agentFastModeCapable?: (agent: AgentKind) => boolean;
}): string | null {
  const { selectedFavoriteUid, favorites, entries, liveEffort, liveFast, liveAgent } = args;
  if (!selectedFavoriteUid) return null;
  // 选中的收藏必须仍然存在(规格 §1.5 删除回落;换账号后旧 uid 查无此条同此兜底)。
  const item = favorites.find((favorite) => favorite.uid === selectedFavoriteUid);
  if (!item) return null;
  const entry = entries.find(
    (candidate) =>
      candidate.providerId === item.providerId && entryMatchesModelId(candidate, item.modelId),
  );
  if (!entry) return selectedFavoriteUid;
  const config = resolveFavoriteRowConfig({
    entry,
    item,
    ...(args.agentFastModeCapable ? { agentFastModeCapable: args.agentFastModeCapable } : {}),
  });
  if (liveAgent !== null && config.agent !== liveAgent) return null;
  if (liveEffort && config.effort !== null && config.effort !== liveEffort) return null;
  if (config.fast !== (config.fastCapable ? liveFast : false)) return null;
  return selectedFavoriteUid;
}

/**
 * 该收藏是否**就是**该模型的推荐配置 —— 决定收藏行右侧要不要挂 `引擎 · 深度 [⚡]` 后缀
 * (规格 §1.5「非默认配置条目右侧显示后缀」)。
 */
export function isRecommendedFavoriteConfig(
  entry: UnifiedModelEntry,
  config: UnifiedRowConfig,
): boolean {
  if (config.engine !== engineOfAgentKind(entry.recommended)) return false;
  if (config.fast) return false;
  const defaultEffort = config.capability?.defaultEffort ?? null;
  if (config.effort === null || defaultEffort === null) return true;
  return config.effort === defaultEffort;
}

// ── 列表陈列 ────────────────────────────────────────────────────────────────

/**
 * rail 的一格。`provider` 格按行的来源供应商派生,不写死内置三家;
 * `engine` 格只在**会话内**出现(规格 §1.6:图标 = 当前会话引擎,默认选中)。
 */
export type UnifiedRailItem =
  | { kind: 'favorites' }
  | { kind: 'engine'; agent: AgentKind }
  | { kind: 'all' }
  | { kind: 'provider'; providerId: string };

export type UnifiedRailFilter = UnifiedRailItem;

export function railItemKey(item: UnifiedRailItem): string {
  if (item.kind === 'provider') return `provider:${item.providerId}`;
  if (item.kind === 'engine') return `engine:${item.agent}`;
  return item.kind;
}

/**
 * rail 项派生:★收藏(**常驻**) → 同引擎(仅会话内) → 全部 → 各来源供应商
 * (按行首次出现序,即联合列表的引擎优先序 × catalog 序)。
 *
 * 「同引擎」格刻意排在 ★ 之下、全部之上(规格 §1.6):它是会话内的**默认视图**,
 * 但收藏仍是用户自己钉的东西,优先级更高。
 *
 * 刻意**不收** favorites:★ 常驻是裁决(见函数体注释),格位与收藏条目多少无关 ——
 * 收着一个不看的参数只会让调用方以为「传了它就会影响 rail」。
 */
export function buildUnifiedRail(
  entries: readonly UnifiedModelEntry[],
  sessionAgent?: AgentKind,
  providerOrder?: readonly string[],
): UnifiedRailItem[] {
  const items: UnifiedRailItem[] = [];
  // ★ 常驻(设计稿 renderRail:collection 永远在第一格,空收藏点进去看空态引导)——
  // 只在有收藏时出现会让功能不可发现(Chris 2026-08-13 实测:「分类栏直接砍了?」)。
  items.push({ kind: 'favorites' });
  if (sessionAgent) items.push({ kind: 'engine', agent: sessionAgent });
  items.push({ kind: 'all' });
  const seen = new Set<string>();
  const firstSeen: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.providerId)) continue;
    seen.add(entry.providerId);
    firstSeen.push(entry.providerId);
  }
  const ordered =
    providerOrder === undefined ? firstSeen : applyProviderOrderIds(firstSeen, providerOrder);
  for (const providerId of ordered) {
    items.push({ kind: 'provider', providerId });
  }
  return items;
}

export interface UnifiedListRow {
  anchor: UnifiedAnchor;
  entry: UnifiedModelEntry;
  /** 收藏区行才有;模型行为 undefined。 */
  favorite?: ModelFavoriteItem;
}

export interface UnifiedListSection {
  key: string;
  kind: 'favorites' | 'group';
  /**
   * 分组小节的口径 —— **按供应商,不按模型家族**(Chris 2026-08-13 实测裁决:供应商决定
   * 价格,同名模型跨来源混排会让用户没法选)。每个供应商各自成组,标题用
   * providerLabel,与模型设置页同一套名字(Chris 2026-08-16 裁决:废除「授权登录」
   * 合并组 —— 分组名必须直接回答"这是哪家的",不引入第二套口径)。
   */
  group?: { type: 'provider'; providerId: string };
  rows: UnifiedListRow[];
}

function matchesQuery(entry: UnifiedModelEntry, q: string): boolean {
  if (!q) return true;
  return (
    entry.displayName.toLowerCase().includes(q) ||
    entry.modelId.toLowerCase().includes(q) ||
    (entry.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * 行查找的 map key。分隔符用空格而不是裸 NUL:源码里嵌一个 `\0` 会让整个文件被
 * git / rg / grep 判成二进制(diff 只显示 `Bin`、符号一个都搜不到),代价远大于它能防的
 * 那点分隔符冲突 —— provider id 与 model id 都是 slug 形态,不含空格。
 */
function entryKeyOf(providerId: string, modelId: string): string {
  return `${providerId} ${modelId}`;
}

/**
 * 面板列表:**收藏区置顶** → **按供应商分组**。
 *
 * 没有「默认」小节(Chris 2026-08-16 裁决:去掉默认小节,简单一点)—— 服务端的默认
 * 推荐改以**种子收藏**交付(见 modelFavorites.seedDefaultFavorite):gateway 用户的
 * 首个收藏即官方推荐,不想要就取消收藏,不再占一个常驻小节。
 *
 * 分组口径(Chris 2026-08-13 实测裁决):供应商决定价格,不能按模型家族归类把
 * 网关上的 Claude 和订阅登录的 Claude 揉进同一组。**每个供应商各自成组**,组标题由
 * 调用方按 providerLabel 渲染(Chris 2026-08-16 裁决:废除「授权登录」合并组,与
 * 模型设置页同一套名字)。
 *
 * 收藏条目**不**从供应商组里去重移除(规格 §1.2):收藏是配置副本,模型本体仍在原地 ——
 * 移除会让用户在「全部」视图里找不到那个模型。
 *
 * 排序不自己发明:**供应商簇内**按 `sortOrder` 升序(缺省排末尾、相等保持入参序),
 * 簇与组的先后 = 首个条目在入参清单里的位置(= unifiedModelEntries 的供应商迭代序);
 * 调用方传入 `providerOrder`(设置 → 模型供应商的拖动序)时组间改按该序,未收录的
 * 供应商按首见序追加 —— 与旧版分段选择器同一条「显示偏好」规则,只影响陈列,
 * 不影响来源解析与目录派生的 canonical 顺序。
 */
export function buildUnifiedListSections(args: {
  entries: readonly UnifiedModelEntry[];
  favorites: readonly ModelFavoriteItem[];
  query: string;
  rail: UnifiedRailFilter;
  /**
   * 该行(或该条收藏)**生效引擎**的解析器 —— 同引擎视图的第二道判据(Chris 2026-08-19
   * 裁决,见 `visible` 处的注释)。缺省时维持旧行为(只按候选过滤),本模块的零 IO 约束
   * 因此不受影响:override / pinned / forceEngine 的合成结果由调用方注入,这里不 import store。
   */
  effectiveEngineOf?: (entry: UnifiedModelEntry, favorite?: ModelFavoriteItem) => UnifiedEngine;
  /** 供应商组间显示顺序(设置页拖动序);缺省 = 入参首见序。 */
  providerOrder?: readonly string[];
}): UnifiedListSection[] {
  const { entries, favorites, rail, effectiveEngineOf } = args;
  const q = args.query.trim().toLowerCase();
  const byKey = new Map<string, UnifiedModelEntry>();
  for (const entry of entries) byKey.set(entryKeyOf(entry.providerId, entry.modelId), entry);

  const sections: UnifiedListSection[] = [];

  // ── 收藏区 ── 恒置顶,在任何 rail 视图下都显示;按供应商筛选时只留该来源的收藏。
  const favRows: UnifiedListRow[] = [];
  for (const item of favorites) {
    // 老收藏可能存的是某个引擎的 wire id(合并行之前的行身份就是 wire id):先按归一化 id
    // 精确命中,失配再按「任一引擎的 wire id」扫一遍 —— 否则升级后老收藏会整条消失。
    const entry =
      byKey.get(entryKeyOf(item.providerId, item.modelId)) ??
      entries.find(
        (candidate) =>
          candidate.providerId === item.providerId && entryMatchesModelId(candidate, item.modelId),
      );
    // 收藏指向的模型已不可路由(来源断开 / 目录下架)→ 本轮不显示;**不删条目**:
    // 连回来就该回来,静默删掉用户存过的配置是不可逆的。
    if (!entry) continue;
    if (rail.kind === 'provider' && entry.providerId !== rail.providerId) continue;
    // 同引擎视图:收藏按**解析后的生效引擎**过滤(与模型行同一条判据 —— 规格 §1.6
    // 「只显示生效引擎 = 当前引擎的行」)。判据只有这一个,不再先按条目自存的 item.agent
    // 硬排除(2026-08-19 review P2):两者在「条目引擎掉出候选」时会分叉 ——
    //   · 存的引擎还在候选里:解析结果 == item.agent,两种判法等价;
    //   · 存的引擎掉出候选、解析回落到**当前引擎**:点它无损、画出来也是当前引擎,
    //     先比 item.agent 会把它错杀出「无损」视图;
    //   · 掉出候选、回落到**别家**:解析判据照样把它滤掉。
    // 没注入解析器的调用方(草稿 all 视图等不带 engine rail 的入口用不到;防御旧调用)
    // 才回退按 item.agent 比。
    if (rail.kind === 'engine') {
      const favoriteEngine = effectiveEngineOf ? effectiveEngineOf(entry, item) : item.agent;
      if (favoriteEngine !== engineOfAgentKind(rail.agent)) continue;
    }
    if (!matchesQuery(entry, q)) continue;
    favRows.push({
      anchor: {
        kind: 'fav',
        uid: item.uid,
        providerId: item.providerId,
        modelId: item.modelId,
      },
      entry,
      favorite: item,
    });
  }
  if (favRows.length > 0) {
    sections.push({ key: 'favorites', kind: 'favorites', rows: favRows });
  }

  if (rail.kind === 'favorites') return sections;

  // ── 分组区 ──
  // 同引擎视图要两个条件同时成立(**这两条与行的落点是同一条规则的两半,改一处必须改另
  // 一处** —— 落点在 resolveUnifiedRowConfig):
  //   1. **候选**里有当前引擎:选它可以留在本会话的引擎上(无损直切);
  //   2. 该行的**生效引擎就是当前引擎**(Chris 2026-08-19 裁决,注入解析器时才判)。
  //
  // 第 2 条是本次补上的:只判候选会把「候选里有当前引擎、但默认落点在别处」的行放进来 ——
  // 主场在别处的行(codex 会话里的 Claude 系,pinnedEngine 对它不生效)、以及用户把 override
  // 显式指到别的引擎的行。它们在「仅 Claude」视图里以**外引擎形态**出现,点下去还会触发跨
  // 引擎切换确认,与该视图「这里选什么都无损」的承诺直接冲突。裁决是**不显示**而不是把它们
  // 转换成当前引擎:用户的设置(主场 / override)明摆着没打算在本引擎用它,要跨引擎去
  // 「全部 / 供应商」视图显式选。§2.1 的 pinnedEngine 例外保持不变 —— 无主场的行本就落在当前
  // 引擎上,自然通过这一条。
  const visible = entries.filter(
    (entry) =>
      matchesQuery(entry, q) &&
      (rail.kind !== 'provider' || entry.providerId === rail.providerId) &&
      (rail.kind !== 'engine' ||
        (entry.candidates.includes(rail.agent) &&
          (!effectiveEngineOf || effectiveEngineOf(entry) === engineOfAgentKind(rail.agent)))),
  );
  // 供应商簇内按 sortOrder 排,簇间保持入参首见序 —— 全局按 sortOrder 排会把不同
  // 供应商的条目按服务端编号交错混排,正是要修掉的形态。
  const clusterOrder: string[] = [];
  const clusters = new Map<string, UnifiedModelEntry[]>();
  for (const entry of visible) {
    let cluster = clusters.get(entry.providerId);
    if (!cluster) {
      cluster = [];
      clusters.set(entry.providerId, cluster);
      clusterOrder.push(entry.providerId);
    }
    cluster.push(entry);
  }
  const orderedClusterOrder =
    args.providerOrder === undefined
      ? clusterOrder
      : applyProviderOrderIds(clusterOrder, args.providerOrder);
  const base: UnifiedModelEntry[] = [];
  for (const providerId of orderedClusterOrder) {
    base.push(
      ...[...clusters.get(providerId)!].sort(
        (a, b) =>
          (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY),
      ),
    );
  }
  const bucketOrder: string[] = [];
  const buckets = new Map<string, { group: UnifiedListSection['group']; items: UnifiedModelEntry[] }>();
  for (const entry of base) {
    const key = `provider:${entry.providerId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        group: { type: 'provider' as const, providerId: entry.providerId },
        items: [],
      };
      buckets.set(key, bucket);
      bucketOrder.push(key);
    }
    bucket.items.push(entry);
  }
  for (const key of bucketOrder) {
    const bucket = buckets.get(key)!;
    // 单引擎视图(会话内的「同引擎」格)在**组内**把原生底座 == 该引擎的行提前、
    // 客串行(主场明确在别处)排后,无主场行不降级 —— codex 会话里先看到 GPT 系。
    // 新会话的全量视图**不动**簇内排序:那里没有"当前引擎"这个参照系。
    const items =
      rail.kind === 'engine' ? sortEntriesForAgent(bucket.items, rail.agent) : bucket.items;
    sections.push({
      key: `group:${key}`,
      kind: 'group',
      group: bucket.group,
      rows: items.map((entry) => ({
        anchor: { kind: 'model', providerId: entry.providerId, modelId: entry.modelId },
        entry,
      })),
    });
  }
  return sections;
}

// ── 选中行对齐 ──────────────────────────────────────────────────────────────

export interface SelectedRowAlignment {
  /** 对齐后的目标 scrollTop(已夹紧到 `[0, scrollHeight - clientHeight]`)。 */
  scrollTop: number;
  /** 行比可视区还高 —— 只能顶对齐,且**一次收工**(继续追居中会上下互相触发、来回振荡)。 */
  oversized: boolean;
}

/**
 * 打开面板 / 切视图时,把选中行滚到**可视区中部**(Chris 2026-08-19 实测反馈:
 * 「尽量保持在他上面的内容能展示,尽量在列表中部是当前选中的」)。
 *
 * 为什么不是「最小滚动进可视区」(改动前的做法):面板挂在 morph 弹层里,首开那一帧列表
 * 高度还是 pill 的裁切态 —— 极矮的可视区里做最小滚动,等价于把选中行顶到列表最上沿;等
 * morph 长开,那一行就死死钉在顶部,它上面的收藏第 1、2 条被顶出可视区。用户点了收藏第 3
 * 条再打开面板,看到的是「焦点永远在下面,收藏区不见了」。居中对齐天然给上方留出同等篇幅,
 * 生长过程中每次尺寸回调重算也始终指向同一个视觉位置。
 *
 * 纯函数:对齐是「ResizeObserver 里改 scrollTop」这类最容易写出振荡的地方,必须能脱离
 * 浏览器直接测。坐标一律用**滚动内容坐标系**(行的位置 = `rowRect.top - listRect.top + scrollTop`)。
 */
export function computeSelectedRowScrollTop(args: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** 可视区顶部被覆盖层遮住的高度(badge 的滚动题头实底);无遮挡传 0。 */
  headerInset: number;
  /** 选中行相对**滚动内容**顶部的上 / 下沿。 */
  rowTop: number;
  rowBottom: number;
}): SelectedRowAlignment {
  const maxScrollTop = Math.max(0, args.scrollHeight - args.clientHeight);
  const clamp = (value: number): number =>
    Math.round(Math.min(Math.max(0, value), maxScrollTop));
  // 题头带盖住的那一条不算可视高度:按它算居中,行会偏上一半题头高。
  const visibleHeight = Math.max(0, args.clientHeight - args.headerInset);
  if (args.rowBottom - args.rowTop >= visibleHeight) {
    return { scrollTop: clamp(args.rowTop - args.headerInset), oversized: true };
  }
  const rowCenter = (args.rowTop + args.rowBottom) / 2;
  return {
    scrollTop: clamp(rowCenter - args.headerInset - visibleHeight / 2),
    oversized: false,
  };
}

// ── 浮层定位 ────────────────────────────────────────────────────────────────

export interface FlyoutRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FlyoutPlacement {
  left: number;
  top: number;
  side: 'left' | 'right';
}

/**
 * 行与浮层之间的缝隙。压到 4px 是**交互决定不是审美决定**:缝隙越宽,鼠标横穿它的时间
 * 越长,越容易在半路把浮层收掉(2026-08-13 实测)。宿主还会把这 4px 并进浮层包装的
 * padding 里,使缝隙本身也是可 hover 区域 —— 两手都做,视觉上仍是 4px 的呼吸。
 */
export const UNIFIED_FLYOUT_GAP = 4;

/**
 * 配置浮层的定位(规格 §1.3「跟随行垂直位置、面板内夹紧」)。
 *
 * 水平:默认贴在面板**左**外侧(设计稿形态);左边放不下才翻到右侧;两侧都放不下时
 * 取能露出更多的一侧并夹到视口内 —— 宁可压住面板边缘,也不能把浮层丢到屏幕外。
 * 垂直(设计稿 flyFinish 算法):顶端对齐锚点行(上抬 `rowOffset` 让标题与行大致齐平),
 * 但**钳制在面板纵向范围内** —— 浮层底不越过面板底(hover 底部行时自然变成与面板
 * 底对齐),浮层顶不高过面板顶;浮层比面板还高时顶对齐面板。视口安全区仍是最外层
 * 兜底(2026-08-13 实测:只按视口夹,底部行的浮层整体滑到面板下方)。
 *
 * 纯函数:定位是「滑杆一动面板就抖」这类问题的高发区,必须能脱离浏览器直接测。
 */
export function computeFlyoutPlacement(args: {
  anchor: FlyoutRect;
  panel: FlyoutRect;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
  margin?: number;
  rowOffset?: number;
}): FlyoutPlacement {
  const gap = args.gap ?? UNIFIED_FLYOUT_GAP;
  const margin = args.margin ?? 8;
  const rowOffset = args.rowOffset ?? 12;
  const { anchor, panel, size, viewport } = args;

  const leftCandidate = panel.left - gap - size.width;
  const rightCandidate = panel.right + gap;
  let side: 'left' | 'right';
  if (leftCandidate >= margin) side = 'left';
  else if (rightCandidate + size.width <= viewport.width - margin) side = 'right';
  else side = leftCandidate >= viewport.width - (rightCandidate + size.width) ? 'left' : 'right';
  const rawLeft = side === 'left' ? leftCandidate : rightCandidate;
  const left = Math.min(
    Math.max(margin, rawLeft),
    Math.max(margin, viewport.width - size.width - margin),
  );
  // 窗口太窄、两侧都塞不下时上面的钳制会把浮层推到视口边:此时它可能与面板叠一部分,
  // 这是**有意的**取舍 —— 压住面板边缘还能用,飘到屏幕外就彻底不可用了(§1.3 视口夹紧)。

  // 设计稿:top = clamp(rowTop - rowOffset, min(panelTop, panelBottom - flyH), panelBottom - flyH)。
  const panelMaxTop = panel.bottom - size.height;
  let top = Math.min(anchor.top - rowOffset, panelMaxTop);
  top = Math.max(top, Math.min(panel.top, panelMaxTop));
  // 视口安全区兜底(面板本身贴近屏幕边缘时不让浮层出屏)。
  const viewportMaxTop = Math.max(margin, viewport.height - size.height - margin);
  top = Math.min(Math.max(margin, top), viewportMaxTop);
  return { left, top, side };
}

/**
 * 价格档($ 串)分档 —— 设计稿 v4 定稿的行内价格样式(F):每个付费行显示 $×1-3,
 * 折扣行在其上做亮段填充。
 *
 * 档位按**标准输出价**判(USD / Mtok;CNY 报价按 ~7 折算),折扣不改变模型的价格档 ——
 * 档表达「这个模型本身贵不贵」,省了多少由亮段比例与 ↓X% 表达。分界取自当前目录的
 * 真实价带:轻量模型(DeepSeek / Haiku / GPT mini 级,输出 ≤$3)一档,主力模型
 * (Sonnet / GPT 5.6 级,≤$15)二档,旗舰(Opus / Fable 级)三档。
 */
export function priceTierOf(outputPerMtok: number, currency: string): 1 | 2 | 3 {
  const usd = currency === 'CNY' ? outputPerMtok / 7 : outputPerMtok;
  if (usd <= 3) return 1;
  if (usd <= 15) return 2;
  return 3;
}
