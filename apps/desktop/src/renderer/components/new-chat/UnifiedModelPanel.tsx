import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  unifiedModelEntries,
  type CatalogModel,
  type ProviderView,
  type UnifiedModelEntry,
} from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { cn } from '@/lib/utils';
import {
  modelPriceDiscountLabelValues,
  type ModelPricePresentation,
} from '@/lib/modelPriceFormat';
import type { Effort } from '@/lib/userPreferences.types';
import { getModelEngineOverride, useModelEnginePrefsVersion } from '@/state/modelEnginePrefs';
import { useModelPickerLayout } from '@/state/modelPickerLayout';
import { useModelFavorites, type ModelFavoriteItem } from '@/state/modelFavorites';
import { useProviderModelMemoryVersion } from '@/state/providerModelMemory';

import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { MORPH_CONTENT_RESIZE_EVENT } from '@/components/ui/morph-popover';

import { ModelConfigFlyout, type ModelConfigFlyoutState } from './ModelConfigFlyout';
// ModelSelector 反过来也 import 本文件 —— ESM 循环 import 在这里安全:两边用到的都是
// **函数声明**(提升),且只在 render 时求值,不在模块求值期互相读值。
import type { ModelMemoryAccessors } from './ModelSelector';
import { ProviderRailMark, UnifiedFlyoutHost } from './UnifiedFlyoutHost';
import { UnifiedModelRail } from './UnifiedModelRail';
import { useUnifiedRowActions } from './useUnifiedRowActions';
import { UnifiedModelRow } from './UnifiedModelRow';
import {
  anchorKey,
  engineOfAgentKind,
  entryMatchesModelId,
  wireModelIdOf,
  buildUnifiedListSections,
  buildUnifiedRail,
  priceTierOf,
  railItemKey,
  resolveFavoriteRowConfig,
  resolveUnifiedRowConfig,
  sameAnchor,
  type UnifiedAnchor,
  type UnifiedEngine,
  type UnifiedRailFilter,
  type UnifiedRowConfig,
} from './unifiedModelSelection';

/** ☆ 点亮反馈时长(规格 §1.5「点亮 0.7s 反馈后恢复」)。 */
const FAVORITE_FEEDBACK_MS = 700;
/** badge 样式的固定视图 —— 模块级常量保证引用稳定,不打穿 sections 的 useMemo。 */
const BADGE_RAIL_ALL: UnifiedRailFilter = { kind: 'all' };
/**
 * 鼠标离开行到收起浮层之间的 grace period。
 *
 * 80ms 是行内 Radix 子面板的老值(那里行与面板几乎贴着);统一浮层是 portal + fixed,
 * 鼠标要横穿一段缝隙才够得到它,80ms 会在半路把浮层收掉(2026-08-13 实测)。缝隙本身
 * 已经并进浮层包装的 padding(见 UnifiedFlyoutHost),这里再给足时间兜住抬手 / 手抖。
 */
const FLYOUT_CLOSE_GRACE_MS = 240;
/** 鼠标是朝浮层那一侧离开行的 —— 明显的「我要去浮层」意图,给更长的窗口。 */
const FLYOUT_CLOSE_GRACE_TOWARD_MS = 600;

/**
 * badge 样式滚动题头的**一套位形**(下面三处必须同源派生,拆开写过就漂过:横幅本身的
 * 高度 / 渐变、updateStickyLabel 的接管与顶出阈值、ensureSelectedVisible 的上界)。
 *
 * 这组数字与真组头的 `pt-1 / pb-3 / leading-none` + 列表 `p-2` 是同一套位形:
 * 列表上衬 8 + 组头上衬 4 + 文字行内居中 ≈ 文字距列表顶 13px,题头卡接管的那一瞬要与
 * 真组头逐像素重合。
 *   - SOLID:横幅的**不透明实底**高度。文字上下各留约 13px 净空;实底只到文字下缘就
 *     渐隐,下一行的字会贴着题头文字冒出来(Chris 2026-08-16 实测「贴底」)。
 *     它也是自动对齐时必须让开的遮挡带 —— 实底之下的内容看不见,把选中行滚到 listTop
 *     等于把它藏在题头后面。
 *   - TOTAL:实底 + 12px 渐隐尾的整条横幅高度。
 *   - SWITCH_AT:组头盒顶到达这里(此时文字恰好落在钉住位)即被题头卡接管锁死。
 *     顶出阈值 = SWITCH_AT + SOLID:下一组组头贴上实底下缘后 1:1 把在位题头顶出,
 *     推满 SOLID 时正好轮到它自己锁进钉住位,全程无跳变、无空窗。
 */
const BADGE_HEADER_SOLID_PX = 38;
const BADGE_HEADER_TOTAL_PX = 50;
const BADGE_HEADER_SWITCH_AT_PX = 8;

/** 选中一行时回传的生效配置(见 `UnifiedModelPanelProps.onSelect`)。 */
export interface UnifiedSelectedRow {
  /** 该行**生效**引擎(推荐 ⊕ override ⊕ 会话内 pinnedEngine ⊕ 收藏副本)。 */
  engine: UnifiedEngine;
  /** 该行生效的 Fast(不具备能力时恒 false)。 */
  fast: boolean;
  /** 选中的是一条收藏副本时给它的锚点 uid;模型行为 null。 */
  favoriteUid: string | null;
  /**
   * ★该行的**归一化行身份 id**。回调第二参给的是「要发出去的 wire id」,而引擎 override /
   * 收藏 / 选中锚点这类**记住这一行**的事情必须用它 —— 同一逻辑模型在两个引擎下是两条
   * 不同的 wire id,用 wire id 当身份会让「换个引擎再打开」认不出是同一行。
   */
  rowModelId: string;
}

export interface UnifiedModelPanelProps {
  providers: readonly ProviderView[];
  /** 参与联合的引擎;调用方给了 vendorKey 时收窄,缺省 = 三个引擎全参与。 */
  agents?: readonly AgentKind[];
  /** 来源解析口径:已建会话 'session'(含停用拷贝),其余 'draft'。 */
  scope: 'draft' | 'session';
  /** 可见性谓词(本机 modelVisibilityPrefs / device-link 被控端快照,由调用方注入)。 */
  isVisible: (providerId: string, model: CatalogModel, agent: AgentKind) => boolean;
  /** 整供应商排除(SSH 远程排除 chat-bridged Codex 源等)。 */
  excludeProvider?: (provider: ProviderView, agent: AgentKind) => boolean;
  /** 单模型排除(SSH 远程排除订阅直连前缀等)。 */
  excludeModel?: (model: CatalogModel, provider: ProviderView, agent: AgentKind) => boolean;
  /**
   * 谓词之外的**外部刷新信号**(可见性偏好版本、deviceId、SSH 排除位…拼成的串)。
   * 谓词是每次 render 新建的闭包,不能进 useMemo 依赖(否则一 hover 就重建整张联合列表);
   * 用调用方给的这个串作为「口径变了」的唯一判据。
   */
  sourceVersion: string;
  query: string;
  /** 当前选中的 (来源, 模型);providerId 为 null = 跟随默认路由。 */
  selected: { providerId: string | null; modelId: string };
  /** 选中的收藏锚点(M5 接线后由 draft 提供);缺省 = 收藏行不显示选中态。 */
  selectedFavoriteUid?: string | null;
  /** 会话 / 草稿当前真正在用的引擎 —— 判定「这行是不是 live 选中行」。 */
  liveAgentKind: AgentKind | null;
  /** live 选中行的 Fast 实时值(会话 = live;草稿 = 调用方派生)。 */
  fastMode?: boolean;
  /** live 选中行的深度实时值(同上)。 */
  selectedEffort?: Effort;
  modelMemory?: ModelMemoryAccessors;
  /** agent 运行时是否具备 Fast 能力(useAgentCapabilities.hasFastMode)。 */
  agentFastModeCapable: (agent: AgentKind) => boolean;
  /** 价格 / 折扣查询。**modelId 传该引擎的 wire id**(报价表按 wire id 索引)。 */
  priceOf: (
    providerId: string,
    modelId: string,
    agent: AgentKind,
  ) => ModelPricePresentation | null;
  providerLabel: (providerId: string) => string;
  effortLabelOf: (agent: AgentKind, effort: Effort) => string;
  listMaxHeight?: number;
  interactionDisabled?: boolean;
  /** false = 只选模型,不出配置浮层(设置类入口的 configurationEnabled)。 */
  configurationEnabled?: boolean;
  /**
   * **会话内形态**(规格 §1.6)。传了它 = 这是一个已经在跑的会话:
   *   - rail 顶部多一格「同引擎」(图标 = 当前引擎),**默认选中**;该视图只列
   *     引擎匹配的收藏 + 当前引擎能跑的模型(无损直切);
   *   - 该视图里的行**默认落在当前引擎**上(pinnedEngine),用户显式 override 仍优先;
   *   - 显式切到「全部 / 供应商」视图时,列表顶部出现一行克制的有损警示;
   *   - 选中一行时若它的生效引擎 ≠ 当前引擎,走 `onCrossEngineSelect`(调用方执行
   *     performAgentSwitch 那条既有事务链路),而不是普通的 onSelect。
   *
   * `onCrossEngineSelect` 与 `currentAgent` 刻意做成**同一个对象里的必填字段**:会话内
   * 一定存在跨引擎行(浮层引擎胶囊随时能把一行切到别的引擎),没有处理器就等于放一个
   * 点了什么都不会发生的行 —— 类型层面堵住这种假按钮。
   */
  sessionEngineFilter?: {
    currentAgent: AgentKind;
    /**
     * 返回 `false` = 调用方**没有**执行这次切换(典型:跨引擎确认弹窗被取消)。
     * 面板本身不消费返回值,但包在外面的 ModelSelector 靠它决定「收起面板」还是
     * 「把面板留在原地等用户重选」—— 取消后把选择器一起收掉等于惩罚用户的犹豫。
     */
    onCrossEngineSelect: (args: {
      providerId: string;
      modelId: string;
      targetAgent: AgentKind;
      effort: Effort | '';
      /**
       * 目标 Fast(2026-08-17 review)。行 / 收藏副本按**目标引擎**解析并过完能力门控的
       * 那个值 —— 显式给值(含 `false`)时调用方必须原样应用到切换事务,不得按目标记忆
       * 重解析;缺省(拿不到目标配置的入口)才由事务自行解析。
       */
      fast?: boolean;
      /**
       * 这次选中的**收藏锚点**(选普通模型行 = null;引擎胶囊 / 恢复推荐 / 删收藏这些
       * 非「选中一行」的动作不带)。会话侧据此在事务真成功后记住「现在选中的是哪条收藏」——
       * 取消 / 失败时锚点一点不动,与 override / 收藏的清理同一条「成功才落」规则。
       */
      favoriteUid?: string | null;
    }) => void | boolean | Promise<void | boolean>;
  };
  /**
   * 可选「跟随会话」行(opt-in,仅 scheduler 的 heartbeat 绑定会话任务)。
   * 语义与既有面板同名 prop 逐字一致:选中 = 模型留空、跟随绑定会话。
   */
  followSession?: { active: boolean; label: string; onFollow: () => void };
  /**
   * 行选中。第 4 个参数是该行**已经合成好的生效配置**(引擎 ⊕ 深度 ⊕ Fast ⊕ 收藏锚点)——
   * 调用方拿到它才能把「模型 + 引擎」当成一件事写下去(M5:草稿的 vendor 就按 `engine` 派生)。
   *
   * 为什么必须由面板回传而不是调用方自己再推一遍:生效引擎 = 推荐(M1) ⊕ 用户 override(M2)
   * ⊕ 会话内 pinnedEngine ⊕ 收藏副本,四路合成的单点实现在 `resolveUnifiedRowConfig`。
   * 调用方重推必然漂移成「行上写着 Codex、写进草稿的却是 Claude」。
   */
  onSelect: (
    providerId: string,
    modelId: string,
    effort: Effort | '',
    config: UnifiedSelectedRow,
  ) => void;
  /**
   * live 选中行改深度 —— 走会话实时状态,不预写记忆(与既有语义一致)。
   * 返回值 = **这次写入真的落下去了没有**(`false` / 抛错 = 没落;返回 void 视为落了)。
   * 「先应用、后清存储」的三个入口(恢复推荐 / 删选中收藏 / 编辑选中收藏)靠它决定要不要收尾。
   */
  onEffortChangeLive?: (effort: Effort) => void | boolean | Promise<void | boolean>;
  /**
   * 清掉当前选中的**收藏锚点**:用户在同模型的**普通模型行**上改了实时深度 / Fast 之后,
   * 正在跑的配置已经不再是那份收藏副本了(2026-08-17 review 第五轮 M2)。
   *
   * 入参形状与 `onSelect` 逐字相同(整行配置 + `favoriteUid: null`),但它**不是一次行选择**:
   * 模型 / 引擎一个字没变,调用方**不要**因此收起面板(用户还在浮层里调档)。草稿把它接到
   * 既有的 favoriteUid 直通链路上,会话等价于 `onSessionFavoriteAnchorChange(null)`。
   */
  onSelectedFavoriteAnchorClear?: (
    providerId: string,
    modelId: string,
    effort: Effort | '',
    config: UnifiedSelectedRow,
  ) => void;
  /**
   * live 选中行改 Fast —— 必须等调用方持久化成功,不预写记忆(device-link 写穿失败会污染
   * 被控端草稿)。返回值语义同 `onEffortChangeLive`。
   */
  onFastModeChangeLive?: (enabled: boolean) => void | boolean | Promise<void | boolean>;
  /** 面板容器元素(浮层按它的左 / 右外侧定位)。 */
  panelElement: HTMLElement | null;
  overlayClassName?: string;
}

/**
 * UnifiedModelPanel —— 统一模型选择器(模型优先)的**面板本体**:跨引擎联合列表 +
 * 行配置浮层(model-selector-unified M3 / M4)。
 *
 * 与旧版「先选引擎再选模型」面板的根本区别:
 *   - 行 = **(来源, 模型)**,横跨它能用的所有引擎;引擎由推荐映射自动配好,并在每行右侧
 *     以「引擎图标 + 推理强度 + ⚡」三元组**常驻显示** —— 引擎可见性靠一致的结构位,
 *     不靠出错才提示。
 *   - 高级调整(引擎 / 深度 / Fast / 收藏)全部收进 hover 浮层,主列表不因 hover 重排。
 *
 * 数据源:M1 的 `unifiedModelEntries`(纯逻辑,已按生效来源解析候选与能力)+ 调用方注入的
 * 可见性 / 排除谓词。本组件**不自己判定候选引擎或能力**,只做合成与呈现。
 */
export function UnifiedModelPanel({
  providers,
  agents,
  scope,
  isVisible,
  excludeProvider,
  excludeModel,
  sourceVersion,
  query,
  selected,
  selectedFavoriteUid = null,
  liveAgentKind,
  fastMode = false,
  selectedEffort,
  modelMemory,
  agentFastModeCapable,
  priceOf,
  providerLabel,
  effortLabelOf,
  listMaxHeight,
  interactionDisabled = false,
  configurationEnabled = true,
  sessionEngineFilter,
  followSession,
  onSelect,
  onSelectedFavoriteAnchorClear,
  onEffortChangeLive,
  onFastModeChangeLive,
  panelElement,
  overlayClassName,
}: UnifiedModelPanelProps) {
  const { t } = useTranslation();
  const favorites = useModelFavorites();
  // 引擎 override / 深度 / Fast 三份 store 的版本号:任一变化都要重算行三元组与浮层
  // (其它窗口的 storage 事件、device-link 推送同样经这两个版本号进来)。
  const enginePrefsVersion = useModelEnginePrefsVersion();
  const memoryVersion = useProviderModelMemoryVersion();

  const sessionAgent = sessionEngineFilter?.currentAgent;
  // 列表样式试用开关(本机偏好):badge = v7 引擎徽标行;classic = 现行样式。
  const pickerLayout = useModelPickerLayout();
  // 会话内默认停在「同引擎」视图(规格 §1.6:切引擎有损,默认给无损那一面)。
  const [rail, setRail] = useState<UnifiedRailFilter>(() =>
    sessionAgent ? { kind: 'engine', agent: sessionAgent } : { kind: 'all' },
  );
  // 会话引擎在外部变化(切换完成 / 换会话)时,把默认视图跟过去 —— 停在旧引擎的
  // 「同引擎」视图上会把新引擎的模型全挡掉(与既有 browseVendor 重置同一动机)。
  const lastSessionAgentRef = useRef(sessionAgent);
  useEffect(() => {
    if (lastSessionAgentRef.current === sessionAgent) return;
    lastSessionAgentRef.current = sessionAgent;
    setRail(sessionAgent ? { kind: 'engine', agent: sessionAgent } : { kind: 'all' });
  }, [sessionAgent]);
  const [flyAnchor, setFlyAnchor] = useState<UnifiedAnchor | null>(null);
  const [flyAnchorEl, setFlyAnchorEl] = useState<HTMLElement | null>(null);
  const [justFavorited, setJustFavorited] = useState<string | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const favoriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 选中行对齐是程序化滚动,它触发的 scroll 事件不代表用户意图,不该收起浮层。
  const suppressScrollDismissRef = useRef(false);
  const previousSelectionRef = useRef<string | null>(null);
  const previousViewRef = useRef<string | null>(null);

  // 谓词走 ref:它们每次 render 都是新闭包,直接进依赖会让 hover(改 flyAnchor state)
  // 也重建整张联合列表。重算时机由 sourceVersion / providers / agentsKey / scope 决定。
  const predicatesRef = useRef({ isVisible, excludeProvider, excludeModel });
  predicatesRef.current = { isVisible, excludeProvider, excludeModel };
  const agentsKey = agents ? agents.join(',') : 'all';
  // 「正在用的引擎」的单一口径:会话内以 sessionAgent 为准(已确认的会话引擎 ⊕ **待切换
  // 意图目标** —— 调用方 ChatInput 在跨引擎意图登记后把 currentAgent 换成意图目标,
  // 2026-08-17 review:意图期内 selected.modelId / effort / fast 全是目标值,引擎口径不跟上
  // 会把目标模型画成旧引擎、浮层摆出旧引擎档位而回调写目标引擎;liveAgentKind 在元数据
  // 未到时可能回退成 cc),草稿才用 liveAgentKind(= 草稿 vendor)。选中行豁免
  // (keepModel.agent)、isLiveRow 与选中行的 forceEngine 必须用**同一个**口径,否则强制显示
  // 出来的引擎反而让 isLiveRow 判不中(2026-08-14 测试当场抓到)。
  const liveEngineAgent = sessionAgent ?? liveAgentKind;
  /**
   * 选中行豁免(`keepModel`)只对**已建会话**开:
   *   - `scope:'session'` = 面板画的是一个正在跑的会话,它选中的模型即便被下架 / 停用也必须
   *     看得见、换得回来(否则一打开就是空选态);
   *   - `scope:'draft'` 是**新路由**,不可路由的条目留在列表里就是个点了会失败的假按钮,
   *     草稿本身另有校准链路把选择迁到可用模型上,不靠面板兜。
   * 引擎未知(会话元数据还没到)时不传:豁免要按 agent 收窄(见 keepModel 头注),没有
   * agent 就无从收窄,宁可这一帧不豁免 —— 元数据到了自然重算。
   */
  const keepModel =
    scope === 'session' && liveEngineAgent
      ? {
          providerId: selected.providerId,
          modelId: selected.modelId,
          agent: liveEngineAgent,
        }
      : null;
  const keepModelKey = keepModel
    ? `${keepModel.providerId ?? ''}::${keepModel.modelId}::${keepModel.agent}`
    : '';
  const entries = useMemo(
    () =>
      unifiedModelEntries({
        providers,
        ...(agents ? { agents } : {}),
        isVisible: (providerId, model, agent) =>
          predicatesRef.current.isVisible(providerId, model, agent),
        excludeProvider: (provider, agent) =>
          predicatesRef.current.excludeProvider?.(provider, agent) ?? false,
        excludeModel: (model, provider, agent) =>
          predicatesRef.current.excludeModel?.(model, provider, agent) ?? false,
        scope,
        // 选中行豁免:会话正在用的那一条即便被停用或服务端下架,也必须留在列表里 ——
        // 否则选择器一打开就是空选态,用户看不出自己在跑什么、也换不回来。豁免按 agent
        // 收窄(见上面 keepModel 的推导注释与该选项头注)。
        ...(keepModel ? { keepModel } : {}),
      }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: 谓词经 ref 读取,刷新信号是 sourceVersion(见其注释);agents 以 agentsKey 表达身份;keepModel 以 keepModelKey 表达身份。
    [providers, agentsKey, scope, sourceVersion, keepModelKey],
  );

  const railItems = useMemo(
    () => buildUnifiedRail(entries, sessionAgent),
    [entries, sessionAgent],
  );
  // rail 上的筛选目标消失(供应商断开 / 收藏清空)时回落「全部」,避免停在空视图。
  useEffect(() => {
    if (rail.kind === 'all') return;
    if (railItems.some((item) => railItemKey(item) === railItemKey(rail))) return;
    setRail({ kind: 'all' });
  }, [rail, railItems]);
  // badge 样式:左侧快捷跳转栏整条拿掉(Chris 2026-08-16),视图恒为「全部」——
  // 引擎与渠道已在行内(徽标 + 渠道签),渠道归属再由分栏题头上的供应商图标承担,
  // 快捷跳转的职责就地消化;行内星标仍可收藏。classic 样式的 rail 行为保持不变。
  const effectiveRail = pickerLayout === 'badge' ? BADGE_RAIL_ALL : rail;

  const sections = useMemo(
    () =>
      buildUnifiedListSections({
        entries,
        favorites,
        query,
        rail: effectiveRail,
      }),
    [entries, favorites, query, effectiveRail],
  );

  // 列表变化时只在选中行跑出可视区时做**最小滚动**(与既有面板同一条规则):
  // 选中项自身变化(用户刚点了一行)不做任何对齐,否则点完列表会当场跳位;**只有视图
  // 本身变化**(rail 切换 / 搜索词变化 / 首次打开)才做「确保选中项可见」——数据刷新
  // (目录轮询 / 收藏增删)不夺走用户的滚动位置(2026-08-13 实测:浏览到列表深处时,
  // 后台目录刷新重建 sections 会把人拽回顶部的选中行)。
  const viewKey = `${railItemKey(effectiveRail)}::${query.trim().toLowerCase()}`;
  /**
   * 「需要保证选中行可见」在途标记 —— 对齐不是一次性动作:面板在 morph 弹层里,
   * 首开那一帧列表高度还是 pill 的裁切态,按它算滚动必错且此后不再重算,选中行
   * 就停在可视区外(Chris 2026-08-14 实测:「当前模型必须可见」)。置位后由
   * ResizeObserver 在每次尺寸变化时重新对齐,直到选中行真正可见;用户手动滚动
   * 立即放弃(不跟用户抢滚动条)。
   */
  const needsEnsureVisibleRef = useRef(false);
  const ensureSelectedVisible = useCallback(() => {
    const el = listRef.current;
    if (!el || !needsEnsureVisibleRef.current) return;
    if (el.clientHeight < 1) return; // 还没有真实布局,等下一次尺寸回调。
    const row = el.querySelector<HTMLElement>('[data-model-selected="true"]');
    if (!row) {
      needsEnsureVisibleRef.current = false; // 本视图没有选中行,无事可做。
      return;
    }
    const listRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // badge 样式的滚动题头是**不透明实底**覆盖层,恒盖住列表视口顶部 SOLID 那一带
    // (见 BADGE_HEADER_* 头注)。上界仍按 listRect.top 算的话,自动对齐会把选中行
    // 正好滚进题头背后 —— 用户看到的就是「当前模型没露出来」。
    const headerInset = pickerLayout === 'badge' ? BADGE_HEADER_SOLID_PX : 0;
    const listTopVisible = listRect.top + headerInset;
    // 上界目标:行是所在组第一行时把**组标题**一起露出来(贴顶只见行不见组名,
    // 像被裁了一刀 —— 2026-08-14 实机自查);否则给 8px 呼吸余量。下界恒 8px。
    const group = row.closest('[role="group"]');
    const header = group?.firstElementChild;
    const isFirstRowOfGroup =
      header instanceof HTMLElement && row.previousElementSibling === header;
    const topBoundary = isFirstRowOfGroup
      ? header.getBoundingClientRect().top - 4
      : rowRect.top - 8;
    // 上下两条余量约束装不进可视区(极矮面板)时按顶对齐一次并收工,防止上下修正
    // 相互触发的振荡。题头带不算可视高度。
    if (rowRect.bottom + 8 - topBoundary > el.clientHeight - headerInset) {
      const forced = Math.max(0, el.scrollTop + (topBoundary - listTopVisible));
      if (Math.abs(forced - el.scrollTop) > 1) {
        suppressScrollDismissRef.current = true;
        el.scrollTop = forced;
      }
      needsEnsureVisibleRef.current = false;
      return;
    }
    const delta =
      topBoundary < listTopVisible
        ? topBoundary - listTopVisible
        : rowRect.bottom > listRect.bottom - 8
          ? rowRect.bottom - (listRect.bottom - 8)
          : 0;
    if (Math.abs(delta) > 1) {
      const next = Math.max(0, el.scrollTop + delta);
      if (next !== el.scrollTop) {
        suppressScrollDismissRef.current = true;
        el.scrollTop = next;
      }
      return; // 生长期间可能还会变,保持在途,交给下一次尺寸回调复核。
    }
    // 行已完整可见且容器有真实高度 → 收工。
    needsEnsureVisibleRef.current = false;
  }, [pickerLayout]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // 内容集合变了(切视图 / 搜索 / 数据刷新)→ 通知 morph 宿主重量一次面板尺寸:
    // 增长方向被 min-h-0 钳制链挡住,宿主的 ResizeObserver 看不到(收缩才看得到),
    // 不吱声的话切回大视图面板永远卡在小尺寸(2026-08-14 实机自查)。
    el.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    const raf = requestAnimationFrame(() => {
      const selectionKey = `${selected.providerId ?? ''}::${selected.modelId}::${selectedFavoriteUid ?? ''}`;
      const previous = previousSelectionRef.current;
      previousSelectionRef.current = selectionKey;
      const previousView = previousViewRef.current;
      previousViewRef.current = viewKey;
      if (previous !== null && previous !== selectionKey) {
        needsEnsureVisibleRef.current = false;
        flashScrollbar(el);
        return;
      }
      if (previousView !== null && previousView === viewKey) return;
      needsEnsureVisibleRef.current = true;
      ensureSelectedVisible();
      flashScrollbar(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [ensureSelectedVisible, sections, viewKey, selected.modelId, selected.providerId, selectedFavoriteUid]);
  // morph 生长 / 窗口变化期间尺寸每变一次就复核一次对齐(仅在途标记置位时做事)。
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!needsEnsureVisibleRef.current) return;
      requestAnimationFrame(ensureSelectedVisible);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ensureSelectedVisible]);

  const closeFlyout = useCallback(() => {
    setFlyAnchor(null);
    setFlyAnchorEl(null);
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const scheduleClose = useCallback(
    (delay: number = FLYOUT_CLOSE_GRACE_MS) => {
      cancelClose();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        closeFlyout();
      }, delay);
    },
    [cancelClose, closeFlyout],
  );

  /**
   * 行的 pointerleave:判一下**往哪边走**。朝浮层那一侧离开 = 用户正在去浮层的路上,
   * 给长窗口;朝反方向 / 上下离开 = 正常扫列表,走短窗口。
   * 只用「离开点落在行的哪半边」这一个信号 —— 不做安全三角形那套几何,够用且不会误伤。
   */
  const scheduleCloseFromRow = useCallback(
    (event: { clientX: number; currentTarget: HTMLElement }) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const flyoutRect = flyoutRef.current?.getBoundingClientRect();
      const towardFlyout = flyoutRect
        ? flyoutRect.left < rect.left
          ? event.clientX <= rect.left + 2
          : event.clientX >= rect.right - 2
        : false;
      scheduleClose(towardFlyout ? FLYOUT_CLOSE_GRACE_TOWARD_MS : FLYOUT_CLOSE_GRACE_MS);
    },
    [scheduleClose],
  );

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      if (favoriteTimerRef.current !== null) clearTimeout(favoriteTimerRef.current);
    },
    [],
  );

  // 滚动即收起:浮层锚定行会跟着滚动漂移(桌面菜单惯例,与旧版行配置浮层同解)。
  // 浮层自身的滚动除外。
  useEffect(() => {
    if (!flyAnchor) return;
    const onAnyScroll = (event: Event) => {
      if (flyoutRef.current?.contains(event.target as Node)) return;
      cancelClose();
      closeFlyout();
    };
    document.addEventListener('scroll', onAnyScroll, true);
    return () => document.removeEventListener('scroll', onAnyScroll, true);
  }, [cancelClose, closeFlyout, flyAnchor]);

  useEffect(() => {
    if (interactionDisabled) closeFlyout();
  }, [closeFlyout, interactionDisabled]);

  // ── 行配置合成 ────────────────────────────────────────────────────────────
  // 「正在用的引擎」的口径 = 上面推 keepModel 时用的那一个(liveEngineAgent),不另起一份。

  /** 这一行是不是**当前会话 / 草稿正在用的那一行**(来源 + 模型 + 引擎三者都对上)。 */
  const isLiveRow = useCallback(
    (entry: UnifiedModelEntry, config: UnifiedRowConfig): boolean =>
      // 外部给的是会话 / 草稿里存的 **wire id**,行身份是归一化 id —— 两头都认
      // (entryMatchesModelId),否则合并行之后选中的模型在列表里不高亮。
      entryMatchesModelId(entry, selected.modelId) &&
      (selected.providerId === null || selected.providerId === entry.providerId) &&
      (liveEngineAgent == null || liveEngineAgent === config.agent),
    [liveEngineAgent, selected.modelId, selected.providerId],
  );

  // 选中的收藏锚点**必须仍然存在**才算数(规格 §1.5「删除选中条目时选中回落到对应模型
  // 默认」)。同一条兜底也覆盖切账号:收藏 store 按 dataOwnerId 分区,换号后旧 uid 在新
  // 分区里查无此条 —— 不做这层解析就会两头落空(收藏行没了、模型行的勾又被抑制)。
  const activeFavoriteUid = useMemo(
    () =>
      selectedFavoriteUid && favorites.some((item) => item.uid === selectedFavoriteUid)
        ? selectedFavoriteUid
        : null,
    [favorites, selectedFavoriteUid],
  );

  const configOf = useCallback(
    (entry: UnifiedModelEntry, favorite?: ModelFavoriteItem): UnifiedRowConfig => {
      // 收藏条目只读它自己存的副本(规格 §1.5),不掺模型默认与记忆。
      if (favorite) {
        return resolveFavoriteRowConfig({ entry, item: favorite, agentFastModeCapable });
      }
      // 两个版本号只作重算触发器:store 是模块级单例,值本身不进依赖。
      void enginePrefsVersion;
      void memoryVersion;
      // 当前草稿 / 会话**实际在用**的模型行:引擎显示强制与事实一致(正在跑什么就画
      // 什么),不受推荐 / override / pinned 摆布 —— 2026-08-14 实测抓到草稿在 pi 上跑
      // DeepSeek,行上却按推荐回落显示「Claude」。收藏被选中时不强制(live 的是那条收藏)。
      const isSelectedModelRow =
        !activeFavoriteUid &&
        entryMatchesModelId(entry, selected.modelId) &&
        (selected.providerId === null || selected.providerId === entry.providerId);
      const base = resolveUnifiedRowConfig({
        entry,
        engineOverride: getModelEngineOverride(entry.providerId, entry.modelId),
        // ★ 记忆表按 **wire id** 存取(既有消费方的口径),不是行的归一化身份。
        memoryEffort: (agent) =>
          modelMemory?.getEffort(agent, entry.providerId, wireModelIdOf(entry, agent)),
        memoryFast: (agent) =>
          modelMemory?.getFast(agent, entry.providerId, wireModelIdOf(entry, agent)),
        agentFastModeCapable,
        // 会话内:无主场(或主场就在当前引擎)的模型默认落在**当前会话引擎**上(无损
        // 直切);主场在别处的行保持主场显示。用户显式 override 仍然优先(见
        // resolveUnifiedRowConfig 的 pinnedEngine 注释)。
        ...(sessionAgent ? { pinnedEngine: engineOfAgentKind(sessionAgent) } : {}),
        ...(isSelectedModelRow && liveEngineAgent
          ? { forceEngine: engineOfAgentKind(liveEngineAgent) }
          : {}),
      });
      // **选中行读 live 值**,不读全局记忆:已建会话的深度 / Fast 由 DB / runtime 权威,
      // 其它对话改同一个模型的全局预设不该改写正在跑的这一条(与旧版 rowEffortOf /
      // fastOnOf 的选中行分支同语义)。
      if (!isLiveRow(entry, base)) return base;
      const efforts: readonly string[] = base.efforts;
      const liveEffort =
        selectedEffort && efforts.includes(selectedEffort) ? selectedEffort : base.effort;
      const liveFast = base.fastCapable ? fastMode : false;
      if (liveEffort === base.effort && liveFast === base.fast) return base;
      return {
        ...base,
        effort: liveEffort,
        fast: liveFast,
        customized:
          base.customized ||
          liveFast ||
          (liveEffort !== null &&
            base.capability?.defaultEffort != null &&
            liveEffort !== base.capability.defaultEffort),
      };
    },
    [
      activeFavoriteUid,
      agentFastModeCapable,
      enginePrefsVersion,
      fastMode,
      isLiveRow,
      liveEngineAgent,
      memoryVersion,
      modelMemory,
      selected.modelId,
      selected.providerId,
      selectedEffort,
      sessionAgent,
    ],
  );

  const isSelectedRow = useCallback(
    (anchor: UnifiedAnchor, entry: UnifiedModelEntry): boolean => {
      if (anchor.kind === 'fav') return activeFavoriteUid === anchor.uid;
      // 收藏锚点被选中时,模型行不同时打勾(锚点语义:选中的是那一条收藏)。
      if (activeFavoriteUid) return false;
      // 会话 / 草稿存的是 wire id;按「行 id 或任一引擎 wire id 命中」解析(合并行契约)。
      return (
        entryMatchesModelId(entry, selected.modelId) &&
        (selected.providerId === null || selected.providerId === anchor.providerId)
      );
    },
    [activeFavoriteUid, selected.modelId, selected.providerId],
  );

  /** ☆ 点亮 0.7s 后恢复(规格 §1.5:源头行不持有收藏态,只给一次动作反馈)。 */
  const flashFavorite = (key: string) => {
    setJustFavorited(key);
    if (favoriteTimerRef.current !== null) clearTimeout(favoriteTimerRef.current);
    favoriteTimerRef.current = setTimeout(() => {
      favoriteTimerRef.current = null;
      setJustFavorited(null);
    }, FAVORITE_FEEDBACK_MS);
  };

  // ── 写入(引擎 / 深度 / Fast / 收藏 / 选中)────────────────────────────────
  // 这些是**唯一**会改用户数据的地方,集中在一个 hook 里(useUnifiedRowActions),
  // 便于逐条对照规格审:哪一步写 store、哪一步交给调用方、哪一步什么都不写。
  const {
    applyEngine,
    applyEffort,
    applyFast,
    resetToRecommended,
    addFavorite,
    removeFavorite,
    selectRow,
  } = useUnifiedRowActions({
    interactionDisabled,
    isLiveRow,
    // 两笔实时写入(深度 + Fast)里第二笔失败时回滚第一笔用的原值 —— 与 configOf 里
    // 「选中行读 live 值」取的是同一个格子(见 useUnifiedRowActions.liveEffort)。
    liveEffort: selectedEffort,
    modelMemory,
    onEffortChangeLive,
    onFastModeChangeLive,
    onSelect,
    onSelectedFavoriteAnchorClear,
    sessionEngineFilter,
    sessionAgent,
    // 「假设引擎 override = engine」的行配置:目标引擎的 wire id / 深度记忆 / Fast 记忆
    // 一次解析齐(applyEngine 的选中行分支用,详见 useUnifiedRowActions)。
    resolveEngineConfig: (entry, engine) =>
      resolveUnifiedRowConfig({
        entry,
        engineOverride: engine,
        memoryEffort: (agent) =>
          modelMemory?.getEffort(agent, entry.providerId, wireModelIdOf(entry, agent)),
        memoryFast: (agent) =>
          modelMemory?.getFast(agent, entry.providerId, wireModelIdOf(entry, agent)),
        agentFastModeCapable,
      }),
    // 「按这份收藏副本解析该行」——与收藏行渲染(configOf 的 favorite 分支)走**同一个**
    // resolveFavoriteRowConfig:编辑选中收藏的引擎时,新引擎的 wire id / 档位回落 / Fast
    // 能力必须与编辑完之后行上显示的那一份逐字一致(详见 useUnifiedRowActions)。
    // uid 在这里无意义(解析只看配置),给空串占位。
    resolveFavoriteConfig: (entry, favorite) =>
      resolveFavoriteRowConfig({ entry, item: { uid: '', ...favorite }, agentFastModeCapable }),
    // 「该行没有收藏语境时的默认配置」:引擎 = 推荐 ⊕ 用户 override ⊕ 会话 pinned(与
    // configOf 的模型行分支同一套合成,少给一路就会算出一个用户从没见过的引擎),
    // **刻意不传 memoryEffort / memoryFast** —— 回落的是「该模型的默认」,不是用户上次在
    // 那个引擎上留下的自定义档;两个记忆访问器缺省时 resolveUnifiedRowConfig 自然给出
    // 目录默认档 + Fast 关。删除当前选中的收藏时按它回落(见 useUnifiedRowActions)。
    resolveDefaultRowConfig: (entry) =>
      resolveUnifiedRowConfig({
        entry,
        engineOverride: getModelEngineOverride(entry.providerId, entry.modelId),
        agentFastModeCapable,
        ...(sessionAgent ? { pinnedEngine: engineOfAgentKind(sessionAgent) } : {}),
      }),
    selectedFavoriteUid: activeFavoriteUid,
    onFavoriteFlash: flashFavorite,
    onBeforeRemoveFavorite: (anchor) => {
      if (sameAnchor(flyAnchor, anchor)) closeFlyout();
    },
  });

  // ── 浮层 ─────────────────────────────────────────────────────────────────
  const flyTarget = useMemo(() => {
    if (!flyAnchor) return null;
    for (const section of sections) {
      for (const row of section.rows) {
        if (sameAnchor(row.anchor, flyAnchor)) return row;
      }
    }
    return null;
  }, [flyAnchor, sections]);

  // 锚点行被过滤掉(搜索 / rail 切换 / 收藏删除)时收起浮层,不留悬空浮层。
  useEffect(() => {
    if (flyAnchor && !flyTarget) closeFlyout();
  }, [closeFlyout, flyAnchor, flyTarget]);

  const revealFlyout = (anchor: UnifiedAnchor, element: HTMLElement) => {
    if (!configurationEnabled || interactionDisabled) return;
    cancelClose();
    setFlyAnchorEl((current) => (current === element ? current : element));
    setFlyAnchor((current) => (sameAnchor(current, anchor) ? current : anchor));
  };

  /** 焦点离开行:落进浮层就按住不收(← 键刚把焦点送进去的那一下),否则照常收。 */
  const handleRowBlurAway = (related: EventTarget | null) => {
    if (related && flyoutRef.current?.contains(related as Node)) {
      cancelClose();
      return;
    }
    scheduleClose();
  };

  /** ← 键:开浮层并把焦点送进去(浮层挂载 + 定位要一帧,故在 rAF 后再找可聚焦项)。 */
  const revealFlyoutForKeyboard = (anchor: UnifiedAnchor, element: HTMLElement) => {
    if (!configurationEnabled || interactionDisabled) return;
    revealFlyout(anchor, element);
    requestAnimationFrame(() => {
      const focusable = flyoutRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [role="slider"]:not([aria-disabled="true"])',
      );
      focusable?.focus();
    });
  };

  /**
   * 小节标题:收藏 / 供应商分组(Chris 2026-08-13 裁决:按供应商,不按模型家族;
   * 组名与模型设置页同一套 providerLabel)。
   */
  const sectionLabel = (section: (typeof sections)[number]): string =>
    section.kind === 'favorites'
      ? t('newChat.modelSelector.unified.favoritesGroup')
      : section.group
        ? providerLabel(section.group.providerId)
        : '';

  const rows = sections.flatMap((section) => section.rows);
  const hasRows = rows.length > 0;

  // badge 样式:滚动中的「继承目录题头」—— 覆盖层常驻列表视口顶部,显示当前滚过的
  // 组名。不用 sticky:它钉在滚动容器 padding 之下,上沿必漏一条行;覆盖层整条不透明
  // 横幅盖住顶部(含 padding 带),机制上无从透底。
  const [stickyLabel, setStickyLabel] = useState<{
    label: string;
    providerId: string | null;
    /** 被下一组组头顶出时的位移(≤0,px)—— 1:1 跟随滚动,见 updateStickyLabel。 */
    offset: number;
  } | null>(null);
  const updateStickyLabel = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // 真 sticky 力学(Chris 2026-08-16:「没在它出现就锁死…落下来把第一个模型挡住」
    // ——离散阈值切换会让组头先跟滚一段再跳回钉住位,必须做成连续运动):
    //   - 组头盒顶到达 SWITCH_AT 即被题头卡接管锁死,一到位就锁,不多跟一像素;
    //   - 下一组组头盒顶贴上题头实底下缘(PUSH_AT)后,把在位题头 1:1 顶出(offset 随
    //     滚动连续变化),推满实底高度时正好轮到它自己锁进钉住位 —— 全程无跳变、无空窗。
    // 两个阈值都从 BADGE_HEADER_* 派生(见其头注:横幅高度 / 渐变 / 自动对齐上界同源)。
    const SWITCH_AT = BADGE_HEADER_SWITCH_AT_PX;
    const PUSH_AT = SWITCH_AT + BADGE_HEADER_SOLID_PX;
    const listTop = list.getBoundingClientRect().top;
    let current: { label: string; providerId: string | null; offset: number } | null = null;
    let nextTop: number | null = null;
    for (const el of list.querySelectorAll<HTMLElement>('[data-group-label]')) {
      const top = el.getBoundingClientRect().top - listTop;
      if (top < SWITCH_AT) {
        current = {
          label: el.dataset.groupLabel ?? '',
          providerId: el.dataset.groupProvider ?? null,
          offset: 0,
        };
      } else {
        nextTop = top;
        break;
      }
    }
    if (current && nextTop !== null) {
      current.offset = Math.min(0, Math.round(nextTop) - PUSH_AT);
    }
    // 滚动每帧都会进来,内容没变就复用旧引用,不触发重渲染。
    setStickyLabel((prev) =>
      prev?.label === current?.label &&
      prev?.providerId === current?.providerId &&
      prev?.offset === current?.offset
        ? prev
        : current,
    );
  }, []);
  useEffect(() => {
    if (pickerLayout !== 'badge') {
      setStickyLabel(null);
      return;
    }
    updateStickyLabel();
  }, [pickerLayout, sections, updateStickyLabel]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* badge 样式不设左侧快捷跳转栏(Chris 2026-08-16):渠道归属由行内渠道签 +
          分栏题头的供应商图标承担,列表恒为「全部」视图。 */}
      {pickerLayout !== 'badge' && (
        <UnifiedModelRail
          items={railItems}
          active={rail}
          onSelect={setRail}
          providers={providers}
          providerLabel={providerLabel}
          interactionDisabled={interactionDisabled}
        />
      )}


      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {pickerLayout === 'badge' && stickyLabel && (
        <div
          aria-hidden
          // 复刻真组头的静止位形,接管瞬间与列表顶部的真组头逐像素重合;收尾照设计稿
          // .sec:实底渐隐到透明,不画硬线 —— 行从渐变里柔和浮现,不被线拦腰切开。
          // 高度与渐变止点全部由 BADGE_HEADER_* 派生(见其头注),不在这里另写字面量。
          className="pointer-events-none absolute inset-x-0 top-0 z-[6] px-[18px] pt-3 text-11 leading-none text-[var(--text-tertiary)]"
          style={{
            height: BADGE_HEADER_TOTAL_PX,
            background: `linear-gradient(180deg, var(--model-dropdown-bg) 0, var(--model-dropdown-bg) ${BADGE_HEADER_SOLID_PX}px, transparent)`,
            // 顶出位移由滚动位置直接驱动(1:1),不加 transition —— 与滚动逐帧同步,
            // 补间动画反而会让它滞后于手指。
            transform: `translateY(${stickyLabel.offset}px)`,
          }}
        >
          <div className="flex items-center gap-1.5">
            {stickyLabel.providerId && (
              <ProviderRailMark providerId={stickyLabel.providerId} providers={providers} />
            )}
            <span className="truncate">{stickyLabel.label}</span>
          </div>
        </div>
      )}
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('newChat.modelSelector.modelListAria')}
        className={cn(
          // 设计稿 .model-list:8px 内边距、行与行之间无额外间距(行自身 py 8 提供呼吸感)。
          // 底部加宽到 12px:滚到底时最后一行不贴着面板底边/footer(Chris 2026-08-13:
          // 「最底部稍微放宽一点高度」)。
          'morph-panel-list-scroll flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2 pb-3 [scrollbar-gutter:stable]',
          // min-h-0 是能不能滚到底的关键:flex item 的默认 min-height:auto 会让它按内容
          // 撑开、拒绝收缩,于是超出面板的部分被外层裁掉且**滚不到**(2026-08-13 实测:
          // 列表翻不到最下面)。加上 min-h-0 后,面板高度受限时列表自己收缩并内部滚动,
          // 底部的「连接来源」footer 是同级兄弟,始终留在列表下方、不盖住最后一行。
          'min-h-0',
        )}
        // 缺省上限只是「内容很少时别把面板撑太高」的软顶,真正的高度由外层面板给;
        // 二者相加才既不过高、也不会在窄窗口里滚不到底。
        style={{ maxHeight: `${listMaxHeight ?? 428}px` }}
        onScroll={() => {
          // 滚动不派发 pointerleave,浮层会跟着滚出视口的锚点行漂到菜单外 → 一滚就收起。
          // 程序化的选中行对齐不算用户意图,由 suppressScrollDismissRef 放行一次。
          if (suppressScrollDismissRef.current) {
            suppressScrollDismissRef.current = false;
            return;
          }
          // 用户亲手滚动 → 放弃在途的「保证选中行可见」,不跟用户抢滚动条。
          needsEnsureVisibleRef.current = false;
          if (flyAnchor) closeFlyout();
        }}
        onScrollCapture={pickerLayout === 'badge' ? updateStickyLabel : undefined}
      >
        {/* 「跟随会话」行(opt-in,仅 scheduler heartbeat):置于最顶,不属于任何分组。 */}
        {followSession && (
          <>
            <button
              type="button"
              disabled={interactionDisabled}
              onClick={() => followSession.onFollow()}
              role="option"
              aria-selected={followSession.active}
              data-follow-session-row
              className={cn(
                'flex w-full items-center justify-between rounded-[10px] px-2.5 py-2 transition-colors',
                'hover:bg-[var(--model-item-hover)]',
                followSession.active && 'bg-[var(--model-item-hover)]',
                interactionDisabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="truncate text-13 font-medium text-[var(--model-item-text)]">
                {followSession.label}
              </span>
              {followSession.active && (
                <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
              )}
            </button>
            <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
          </>
        )}
        {/* 跨引擎视图的有损警示(规格 §1.6)—— 一行、可截断、不抢占列表高度。
            只在会话内**离开**同引擎视图时出现:同引擎视图里选什么都是无损的,那里摆警示
            等于每次打开都在喊狼来了。badge 样式没有同引擎视图(恒为「全部」),常驻
            警示同样是喊狼来了 —— 有损与否由选中时的跨引擎确认事务把关,这里不摆。 */}
        {pickerLayout !== 'badge' && sessionEngineFilter && effectiveRail.kind !== 'engine' && (
          <div
            role="note"
            data-cross-engine-warning
            title={t('newChat.modelSelector.unified.crossEngineWarning')}
            className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-11 leading-[1.5] text-[var(--warning-fg)]"
          >
            <TriangleAlert size={12} className="shrink-0" />
            <span className="truncate">
              {t('newChat.modelSelector.unified.crossEngineWarning')}
            </span>
          </div>
        )}
        {!hasRows ? (
          <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
            {/* ★ 视图的空态是引导语,不是「没有匹配」(设计稿 favEmpty;★ 常驻后必经)。 */}
            {effectiveRail.kind === 'favorites' && !query.trim()
              ? t('newChat.modelSelector.unified.favoritesEmpty')
              : t('newChat.modelSelector.search.noResults')}
          </div>
        ) : (
          sections.map((section) => (
            <div
              key={section.key}
              role="group"
              aria-label={sectionLabel(section)}
              // badge 样式:组间距放在 section 容器上(组头自身上下衬对称),标签文字
              // 到上一组尾行与到本组首行的距离一致(Chris 2026-08-16:「上下高度对齐」)。
              className={cn(pickerLayout === 'badge' && 'mt-2 first:mt-0')}
            >
              {/* 设计稿 .group-label:11.5px 常规字重、padding 8/10/4。
                  badge 样式的"滚动中组名常驻"不用 sticky(sticky 钉在滚动容器
                  padding 之下,上沿会漏出一条行 —— Chris 2026-08-16 实测),改由
                  列表视口顶部的覆盖层题头承载(见 stickyLabel),这里保持普通元素。
                  badge 样式的组头带供应商图标(快捷跳转栏拿掉后渠道归属落在这里)。 */}
              <div
                data-group-label={sectionLabel(section)}
                {...(section.group?.type === 'provider'
                  ? { 'data-group-provider': section.group.providerId }
                  : {})}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 text-11 text-[var(--text-tertiary)]',
                  // badge:上 4 下 12(配合列表 8px 上衬,顶部文字上下净空各约 13px,
                  // 与滚动题头卡同一套位形);classic 保持既有 8/4 节奏。
                  pickerLayout === 'badge' ? 'pb-3 pt-1 leading-none' : 'pb-1 pt-2',
                )}
              >
                {pickerLayout === 'badge' && section.group?.type === 'provider' && (
                  <ProviderRailMark
                    providerId={section.group.providerId}
                    providers={providers}
                  />
                )}
                <span className="truncate">{sectionLabel(section)}</span>
              </div>
              {section.rows.map((row) => {
                const config = configOf(row.entry, row.favorite);
                const key = anchorKey(row.anchor);
                // 行内价格(设计稿 v4 定稿 F 样式):付费行显示 $ 档串,折扣行亮段按
                // 折后价比例填充并尾随 ↓X%;限免显示淡染小徽标;无报价不渲染节点。
                // 价格按**该行生效引擎的 wire id**查(同一逻辑模型换引擎可能换一条报价)。
                const price = priceOf(
                  row.entry.providerId,
                  config.wireModelId ?? row.entry.modelId,
                  config.agent,
                );
                let priceDisplay:
                  | NonNullable<Parameters<typeof UnifiedModelRow>[0]['priceDisplay']>
                  | null = null;
                // 订阅接入且拿不到按量报价的行:画「订阅」小签,不画 $ 档串(那类模型
                // 走套餐额度,画钱会被读成按量计费)。判定用 provider.access.kind +
                // 报价来源(subscription-reference = 只是价值估算,不是账单价)。
                const rowProvider = providers.find((item) => item.id === row.entry.providerId);
                const subscriptionRow =
                  rowProvider?.access?.kind === 'subscription' &&
                  (price === null || price.kind !== 'priced' || price.current.source === 'subscription-reference');
                if (subscriptionRow) {
                  priceDisplay = null;
                } else if (price?.kind === 'free') {
                  priceDisplay = { kind: 'free' };
                } else if (price?.kind === 'priced') {
                  // 符号个数按**标准价**判(original;折扣不改变模型的价格档),点亮几格按
                  // 折扣比例取整;颜色只由点亮格数决定(见 UnifiedModelRow priceDisplay 头注)。
                  const basis = price.original ?? price.current;
                  const discountPct =
                    price.discount !== undefined ? Math.round(price.discount * 100) : 0;
                  priceDisplay = {
                    kind: 'tier',
                    tier: priceTierOf(basis.outputPerMtok, basis.currency),
                    // 档串符号跟**报价币种**走(设计稿:中文报价是 ¥¥¥)。
                    symbol: basis.currency === 'CNY' ? '¥' : '$',
                    ...(discountPct > 0 && discountPct < 100
                      ? {
                          discountPct,
                          paidPct: 100 - discountPct,
                          title: t(
                            'newChat.modelSelector.pricing.discount',
                            modelPriceDiscountLabelValues(price.discount ?? 0),
                          ),
                        }
                      : {}),
                  };
                }
                return (
                  <UnifiedModelRow
                    key={key}
                    entry={row.entry}
                    anchor={row.anchor}
                    config={config}
                    selected={isSelectedRow(row.anchor, row.entry)}
                    active={sameAnchor(flyAnchor, row.anchor)}
                    isFavoriteRow={!!row.favorite}
                    justFavorited={justFavorited === key}
                    {...(priceDisplay ? { priceDisplay } : {})}
                    {...(subscriptionRow
                      ? { subscriptionLabel: t('settings.providers.models.subscription') }
                      : {})}
                    interactionDisabled={interactionDisabled}
                    effortLabelOf={effortLabelOf}
                    providers={providers}
                    layout={pickerLayout}
                    // badge 样式:右缘来源字签(providerLabel 既有结果);行首徽标点按
                    // 在候选引擎间快切 —— 与浮层引擎胶囊走**同一条 applyEngine 链路**
                    // (选中行的草稿回写 / 会话跨引擎确认语义因此完全一致)。收藏行不给
                    // 快切(☆ 是配置副本,徽标只作标识,改引擎去浮层改那条收藏)。
                    {...(pickerLayout === 'badge'
                      ? {
                          channelLabel: providerLabel(row.entry.providerId),
                          ...(configurationEnabled &&
                          !row.favorite &&
                          row.entry.candidates.length > 1
                            ? {
                                onEngineCycle: () => {
                                  const engines = row.entry.candidates.map(engineOfAgentKind);
                                  const next =
                                    engines[
                                      (engines.indexOf(config.engine) + 1) % engines.length
                                    ];
                                  if (next) applyEngine(row.anchor, row.entry, config, next);
                                },
                              }
                            : {}),
                        }
                      : {})}
                    onReveal={revealFlyout}
                    onRevealForKeyboard={revealFlyoutForKeyboard}
                    onLeave={scheduleCloseFromRow}
                    onBlurAway={handleRowBlurAway}
                    onSelect={() => selectRow(row.anchor, config, row.favorite)}
                    onStar={() =>
                      row.favorite
                        ? removeFavorite(row.anchor, row.entry)
                        : addFavorite(row.anchor, config)
                    }
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
      </div>

      {flyTarget && configurationEnabled && (
        <UnifiedFlyoutHost
          anchorEl={flyAnchorEl}
          panelElement={panelElement}
          flyoutRef={flyoutRef}
          // 列表结构变了(在浮层里点 ☆ 插入收藏小节 → 锚点行整体下移)就重算浮层位置,
          // 否则它停在旧坐标上脱锚。sections 的引用只在真正重建列表时才变。
          repositionKey={sections}
          {...(overlayClassName !== undefined ? { className: overlayClassName } : {})}
          onPointerEnter={cancelClose}
          onPointerLeave={() => scheduleClose()}
          onDismiss={closeFlyout}
        >
          {(() => {
            const target = flyTarget;
            const config = configOf(target.entry, target.favorite);
            const state: ModelConfigFlyoutState = target.favorite
              ? 'favorite'
              : config.customized
                ? 'customized'
                : 'recommended';
            return (
              <ModelConfigFlyout
                entry={target.entry}
                config={config}
                state={state}
                sourceLabel={providerLabel(target.entry.providerId)}
                price={priceOf(
                  target.entry.providerId,
                  config.wireModelId ?? target.entry.modelId,
                  config.agent,
                )}
                effortLabelOf={effortLabelOf}
                justFavorited={justFavorited === anchorKey(target.anchor)}
                disabled={interactionDisabled}
                onEngineChange={(engine) => applyEngine(target.anchor, target.entry, config, engine)}
                onEffortChange={(effort) =>
                  applyEffort(target.anchor, target.entry, config, effort)
                }
                onFastChange={(enabled) => applyFast(target.anchor, target.entry, config, enabled)}
                onResetToRecommended={() =>
                  resetToRecommended(target.anchor, target.entry, config)
                }
                onAddFavorite={() => addFavorite(target.anchor, config)}
                onRemoveFavorite={() => removeFavorite(target.anchor, target.entry)}
              />
            );
          })()}
        </UnifiedFlyoutHost>
      )}
    </div>
  );
}
