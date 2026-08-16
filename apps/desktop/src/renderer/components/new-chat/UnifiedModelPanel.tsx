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
import { UnifiedFlyoutHost } from './UnifiedFlyoutHost';
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
  /**
   * 该行是否被服务端目录标记为新会话默认种子(`CatalogModel.newSessionDefault`)。
   * 命中的行提升到列表顶部的「默认」小节 —— 实测反馈:默认模型混在中部很难找。
   * 判定要读目录条目,数据在 ModelSelector 侧,故注入。
   */
  isDefaultSeed?: (entry: UnifiedModelEntry) => boolean;
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
  /** live 选中行改深度 —— 走会话实时状态,不预写记忆(与既有语义一致)。 */
  onEffortChangeLive?: (effort: Effort) => void;
  /** live 选中行改 Fast —— 必须等调用方持久化成功,不预写记忆(device-link 写穿失败会污染被控端草稿)。 */
  onFastModeChangeLive?: (enabled: boolean) => void | Promise<void>;
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
  isDefaultSeed,
  providerLabel,
  effortLabelOf,
  listMaxHeight,
  interactionDisabled = false,
  configurationEnabled = true,
  sessionEngineFilter,
  followSession,
  onSelect,
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
      }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: 谓词经 ref 读取,刷新信号是 sourceVersion(见其注释);agents 以 agentsKey 表达身份。
    [providers, agentsKey, scope, sourceVersion],
  );

  const railItems = useMemo(
    () => buildUnifiedRail(entries, favorites, sessionAgent),
    [entries, favorites, sessionAgent],
  );
  // rail 上的筛选目标消失(供应商断开 / 收藏清空)时回落「全部」,避免停在空视图。
  useEffect(() => {
    if (rail.kind === 'all') return;
    if (railItems.some((item) => railItemKey(item) === railItemKey(rail))) return;
    setRail({ kind: 'all' });
  }, [rail, railItems]);

  const sections = useMemo(
    () =>
      buildUnifiedListSections({
        entries,
        favorites,
        providers,
        query,
        rail,
        ...(isDefaultSeed ? { isDefaultSeed } : {}),
      }),
    [entries, favorites, isDefaultSeed, providers, query, rail],
  );

  // 列表变化时只在选中行跑出可视区时做**最小滚动**(与既有面板同一条规则):
  // 选中项自身变化(用户刚点了一行)不做任何对齐,否则点完列表会当场跳位;**只有视图
  // 本身变化**(rail 切换 / 搜索词变化 / 首次打开)才做「确保选中项可见」——数据刷新
  // (目录轮询 / 收藏增删)不夺走用户的滚动位置(2026-08-13 实测:浏览到列表深处时,
  // 后台目录刷新重建 sections 会把人拽回顶部的选中行)。
  const viewKey = `${railItemKey(rail)}::${query.trim().toLowerCase()}`;
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
    // 相互触发的振荡。
    if (rowRect.bottom + 8 - topBoundary > el.clientHeight) {
      const forced = Math.max(0, el.scrollTop + (topBoundary - listRect.top));
      if (Math.abs(forced - el.scrollTop) > 1) {
        suppressScrollDismissRef.current = true;
        el.scrollTop = forced;
      }
      needsEnsureVisibleRef.current = false;
      return;
    }
    const delta =
      topBoundary < listRect.top
        ? topBoundary - listRect.top
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
  }, []);
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
  // 「正在用的引擎」的单一口径:会话内以 sessionAgent 为准(已确认的会话引擎;
  // liveAgentKind 在元数据未到时可能回退成 cc),草稿才用 liveAgentKind(= 草稿 vendor)。
  // isLiveRow 与选中行的 forceEngine 必须用**同一个**口径,否则强制显示出来的引擎
  // 反而让 isLiveRow 判不中(2026-08-14 测试当场抓到)。
  const liveEngineAgent = sessionAgent ?? liveAgentKind;

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
    modelMemory,
    onEffortChangeLive,
    onFastModeChangeLive,
    onSelect,
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
   * 小节标题:收藏 / 默认 / 供应商分组(Chris 2026-08-13 裁决:按供应商,不按模型家族)。
   * 「授权登录」合并组走 i18n,单供应商组直接用供应商名(providerLabel)。
   */
  const sectionLabel = (section: (typeof sections)[number]): string =>
    section.kind === 'favorites'
      ? t('newChat.modelSelector.unified.favoritesGroup')
      : section.kind === 'defaults'
        ? t('newChat.modelSelector.unified.defaultsGroup')
        : section.group
          ? providerLabel(section.group.providerId)
          : '';

  const rows = sections.flatMap((section) => section.rows);
  const hasRows = rows.length > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <UnifiedModelRail
        items={railItems}
        active={rail}
        onSelect={setRail}
        providers={providers}
        providerLabel={providerLabel}
        interactionDisabled={interactionDisabled}
      />


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
            等于每次打开都在喊狼来了。 */}
        {sessionEngineFilter && rail.kind !== 'engine' && (
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
            {rail.kind === 'favorites' && !query.trim()
              ? t('newChat.modelSelector.unified.favoritesEmpty')
              : t('newChat.modelSelector.search.noResults')}
          </div>
        ) : (
          sections.map((section) => (
            <div
              key={section.key}
              role="group"
              aria-label={sectionLabel(section)}
            >
              {/* 设计稿 .group-label:11.5px 常规字重、padding 8/10/4。
                  badge 样式下粘性吸顶:滚到组中间时组名钉在列表顶端(v7 设计稿)。
                  吸顶时必须**不透底**且横向铺满滚动区(-mx 出血盖住列表左右 padding,
                  不透明面板底色),否则行从组头下滑过会从两侧和字缝里透出来
                  (Chris 2026-08-16 实测)。 */}
              <div
                className={cn(
                  'truncate text-11 text-[var(--text-tertiary)]',
                  pickerLayout === 'badge'
                    ? 'sticky top-0 z-[5] -mx-2 bg-[var(--model-dropdown-bg)] px-[18px] pb-1 pt-2'
                    : 'px-2.5 pb-1 pt-2',
                )}
              >
                {sectionLabel(section)}
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
                    {...(section.kind === 'defaults'
                      ? { defaultBadge: t('newChat.modelSelector.unified.defaultBadge') }
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
                        ? removeFavorite(row.anchor)
                        : addFavorite(row.anchor, config)
                    }
                  />
                );
              })}
            </div>
          ))
        )}
      </div>

      {flyTarget && configurationEnabled && (
        <UnifiedFlyoutHost
          anchorEl={flyAnchorEl}
          panelElement={panelElement}
          flyoutRef={flyoutRef}
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
                onRemoveFavorite={() => removeFavorite(target.anchor)}
              />
            );
          })()}
        </UnifiedFlyoutHost>
      )}
    </div>
  );
}
