/**
 * ContextWindowBudgetChip — 任务级工作上下文窗口档位选择。
 *
 * 语义（与 main 侧 `model-context-settings.ts` 同一口径）：
 *   - 档位决定**本任务**的工作窗口（分母）；全局的自动压缩阈值百分比不动。
 *   - 「跟随模型默认」= 上报 null，不把当前默认值快照进任务。
 *   - 有效窗口还受用户在同一路由上设过的模型级上限与目录物理上限约束（由 main 收敛），
 *     所以这里展示的是**选择**，运行时真值仍以圆环的窗口读数为准。
 *
 * 生效时机：main 在落库后把新窗口应用到活实例（空闲关 handle、下一条消息冷重建；
 * 回合中登记 pending，回合结束生效）。菜单文案如实说明，不做「立即生效」的假承诺。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';


import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getModelsForVendor } from '@/lib/modelDefinitions';
import { formatModelPriceAmount } from '@/lib/modelPriceFormat';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import {
  STATUS_CARD_HOVER_CLOSE_GRACE_MS,
  STATUS_CARD_HOVER_OPEN_DELAY_MS,
  registerStatusBarCard,
  type StatusBarCardHandle,
} from '@/lib/statusBarCards';

import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import { useGatewayModelPricing, useReferenceModelPricing } from '@/hooks/useModelPricing';
import { useModelContextLimit } from '@/hooks/useModelContextLimit';
import {
  buildContextWindowBudgetOptions,
  contextWindowBudgetTierPercent,
  normalizeContextWindowBudget,
  resolveContextWindowBudgetBase,
} from '../../../shared/sessionContextWindowBudget';
import { resolveRouteContextWindowBounds } from '../../../shared/sessionContextWindow';
import {
  normalizeSessionContextWindowBounds,
  type SessionContextWindowBounds,
} from '../../../shared/sessionContextWindowBounds';
import type { MakerAgentKindWire } from '../../../shared/agentKindConversion';
import { getModelPriceQuote } from '../../../shared/modelPriceQuote';
import type { Catalog } from '@cindy/model-providers';
import type { ModelPriceQuote } from '../../../shared/regionalMoney';

/**
 * 触发器上的标记：一枚「上下双向箭头」符号 + 当前档位百分比（用户拍板）—— 底栏不挂文字标签，
 * 但百分比要看得见（它是「这个任务用多大窗口」的相对口径）。用 ↕ 而不是方括号：方括号语义不明确
 * （读不出"窗口大小"），↕ 至少表达"可上可下 / 可调"。
 * 当前档位的绝对值仍进 `aria-label`（`triggerLabel`）与卡片行（`aria-checked` 命中的那一行）。
 *
 * 它是普通文本（不是图标、也不是括号），与 `¥`、圆环 `1%` 同基线、同字重、同颜色层
 * （`opacity-60`，与货币符号完全一致）。
 *
 * 字号用 `text-11`（用户拍板，`text-10` 略小）：箭头字形天生比数字高 —— 12px 下 `↕` 墨迹 12px
 * （上缘 11 / 下缘 1），而 `¥` 是 9/0、圆环 `1%` 是 9/1；11px 下墨迹 ≈11px（10.1/0.9），
 * 与两个邻居同一基线、同一中心线，观感上也和它们的**字面**大小相当。换字形/字号只需改这两行。
 */
const CONTEXT_WINDOW_MARKER = '↕';

export interface ContextWindowBudgetChipProps {
  sessionId: string;
  /** 运行期上下文占用，用于「换小档位会立刻触发压缩」的提示。 */
  contextTokens: number;
  model: string;
  /** 路由来源；用来查实际报价（网关实价优先，其余用参考价）。 */
  providerId?: string | null;
  agentKind: 'cc' | 'codex' | 'pi';
  /**
   * 该任务实际路由的一份目录（renderer 侧的 `providers`）：
   * 默认窗口与「上限档」都按**路由**解析，不用 availableModels 扁平表
   * （同 id 跨 provider 去重后归属已丢，取到的 max 可能属于另一条路由）。
   * **只在本地任务生效**：device-link 远程任务的路由/上限在被控端，传本地目录会
   * 造成“看到的档位 ≠ 被控端生效值”，那种情况下降级为「只允许收紧」。
   * 拿不到时降级为扁平表的默认值 + 只允许收紧。
   */
  providers?: Pick<Catalog, 'providers'> | null;
  /** device-link 远程任务：档位必须按被控端的目录算（模型 id 跨设备不唯一）。 */
  deviceId?: string;
  disabled?: boolean;
}

/** 该窗口落在哪条价带：band 的 maxInputTokens 是开区间，缺价继承报价基准价。 */
function inputPriceAtTokens(quote: ModelPriceQuote | undefined, tokens: number): string | null {
  if (!quote) return null;
  const band = quote.inputTokenPriceBands
    ?.filter((entry) => tokens >= entry.minInputTokens
      && (entry.maxInputTokens === undefined || tokens < entry.maxInputTokens))
    .at(-1);
  const perMtok = band?.inputPerMtok ?? quote.inputPerMtok;
  if (typeof perMtok !== 'number' || !Number.isFinite(perMtok) || perMtok <= 0) return null;
  return formatModelPriceAmount(perMtok, quote.currency);
}

export function ContextWindowBudgetChip({
  sessionId,
  contextTokens,
  model,
  providerId,
  agentKind,
  providers = null,
  deviceId,
  disabled = false,
}: ContextWindowBudgetChipProps) {
  const { t } = useTranslation();
  const [committing, setCommitting] = useState(false);
  // 卡片开合：**指针悬浮**展开（与货币 chip 的「用量明细」卡同一节奏：延迟 300ms 开、离开宽限
  // 200ms 关），键盘仍走 Radix 自己的 Enter/Space 开、Esc 关。
  const [cardOpen, setCardOpen] = useState(false);
  // 浮层宿主：紧跟触发器之后（见 popover.tsx 的 portalContainer 注释）。
  const [cardPortalHost, setCardPortalHost] = useState<HTMLDivElement | null>(null);
  const cardOpenTimerRef = useRef<number | null>(null);
  const cardCloseTimerRef = useRef<number | null>(null);
  // 指针打开时 Radix 关闭后会把焦点还给触发器，Chrome 会把这次程序化聚焦判成 `:focus-visible`
  // → 出现蓝色外圈（键盘用户需要它，鼠标用户不需要）。用指针来源区分：只有指针打开的这一轮
  // 才在关闭时阻止焦点归还；Tab/Enter 打开时保持原行为。
  // （写在组件顶部：它有早退 return，hook 不能落在 return 之后。）
  const openedByPointerRef = useRef(false);
  const cardPointerInsideRef = useRef(false);
  // 悬浮打开时不要把焦点抢进卡片（键盘打开才需要）。指针是否在卡片区域内决定"要不要抢焦点"。
  const cardOpenSourceRef = useRef<'hover' | 'focus'>('hover');
  // 互斥协调器的本实例句柄（分屏可能同时挂载两个 chip，认实例而不是认种类）。
  const cardHandleRef = useRef<StatusBarCardHandle | null>(null);
  // 档位行的 Tab 停靠点（roving tabindex）：单选组只占一个 Tab 位，方向键在组内移动焦点。
  const tierRowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tierTabStopIndex, setTierTabStopIndex] = useState(0);
  const clearCardTimers = useCallback(() => {
    if (cardOpenTimerRef.current !== null) {
      window.clearTimeout(cardOpenTimerRef.current);
      cardOpenTimerRef.current = null;
    }
    if (cardCloseTimerRef.current !== null) {
      window.clearTimeout(cardCloseTimerRef.current);
      cardCloseTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearCardTimers, [clearCardTimers]);
  const openCard = useCallback((source: 'hover' | 'focus') => {
    clearCardTimers();
    cardOpenSourceRef.current = source;
    // 两卡互斥：自己展开时，用量卡立刻收起（用户要求"该窗体为唯一窗体"）；
    // 分屏下同种类的另一张 chip 也在这条路径上被关掉。
    cardHandleRef.current?.request();
    setCardOpen(true);
  }, [clearCardTimers]);
  const closeCard = useCallback(() => {
    clearCardTimers();
    cardHandleRef.current?.release();
    setCardOpen(false);
  }, [clearCardTimers]);
  const scheduleCardOpen = useCallback(() => {
    clearCardTimers();
    cardOpenTimerRef.current = window.setTimeout(() => {
      cardOpenTimerRef.current = null;
      openCard('hover');
    }, STATUS_CARD_HOVER_OPEN_DELAY_MS);
  }, [clearCardTimers, openCard]);
  const scheduleCardClose = useCallback(() => {
    clearCardTimers();
    cardCloseTimerRef.current = window.setTimeout(() => {
      cardCloseTimerRef.current = null;
      closeCard();
    }, STATUS_CARD_HOVER_CLOSE_GRACE_MS);
  }, [clearCardTimers, closeCard]);
  const cancelCardClose = useCallback(() => {
    if (cardCloseTimerRef.current !== null) {
      window.clearTimeout(cardCloseTimerRef.current);
      cardCloseTimerRef.current = null;
    }
  }, []);
  // 另一张卡（用量卡或分屏里同种类的另一份）展开时由协调器回调过来 → 立刻收起。
  useEffect(() => {
    const handle = registerStatusBarCard('context-window', () => {
      clearCardTimers();
      setCardOpen(false);
    });
    cardHandleRef.current = handle;
    return () => {
      cardHandleRef.current = null;
      handle.unregister();
    };
  }, [clearCardTimers]);
  // 在飞期间菜单项是 disabled（见 isDisabled）——用户看得见的禁用，而不是静默丢弃；
  // 跨窗口并发（两个 chip 实例各有自己的 state）由 main 侧的会话锁 + 终值比对负责收敛。
  // 分档计费模型的档位就是价带：把每条档位的输入单价摆在选项里，用户选的是成本。
  const gatewayPricing = useGatewayModelPricing();
  const referencePricing = useReferenceModelPricing();

  // 目录默认窗口与物理上限：拿不到默认值就没有档位可给（例如能力缓存还没到），此时不渲染，
  // 而不是拿兜底数字造一个用户点不到真值的控件。上限缺省 = 只能收紧（老目录形态）。
  // 路由级解析优先（唯一候选 + 实际 providerId，Pi/Codex 一视同仁），扁平表只做默认值的
  // 降级来源；远程任务（deviceId）不用本地目录，只用被控端能力缓存里的默认值。
  const makerAgent = agentKind === 'cc' ? 'claude-code' : agentKind;
  const modelEntry = useMemo(
    () => getModelsForVendor(agentKind, deviceId).find((entry) => entry.id === model),
    [agentKind, deviceId, model],
  );
  const localRouteBounds = useMemo(
    () => (providers && !deviceId
      ? resolveRouteContextWindowBounds(providers, makerAgent, providerId ?? null, model)
      : null),
    [providers, deviceId, makerAgent, providerId, model],
  );
  // **权威边界**：本地由 main 按会话实际路由解析（与运行期收敛同源），远程向被控端拉同一份
  // 口径的只读查询。拿不到（老被控端/失败）就退回「只允许收紧」+ 下方 renderer 自解析的兜底，
  // 绝不把「另一条路由」的值当成事实。
  const {
    bounds: authoritativeBounds,
    boundsFetchedAt,
    refresh: refreshBounds,
    refreshIfStale: refreshBoundsIfStale,
  } = useSessionContextWindowBounds(deviceId, sessionId, model, makerAgent, providerId ?? null);
  // main 的解析优先（它认得隐式来源与模型级上限）；未返回前用 renderer 自解析的兜底，
  // 兜底解不出来源时只会更保守（上限缺省 = 只允许收紧）。
  const defaultWindow = authoritativeBounds?.defaultWindow
    ?? localRouteBounds?.defaultWindow
    ?? (typeof modelEntry?.contextWindow === 'number' && modelEntry.contextWindow > 0
      ? modelEntry.contextWindow
      : null);
  // 上限只信路由级：扁平表跨 provider 去重后归属已丢，不能当上限来源。
  const maxWindow = authoritativeBounds?.maxWindow ?? localRouteBounds?.maxWindow ?? null;
  // 同一路由上用户设过的模型级「上下文上限」是更紧的上界（main 侧 tighterBudget 一定会取
  // 更紧者）；不读它会让档位表和生效值分叉。providerId 缺失时用路由解出的来源补上
  // （与 main 侧的来源解析同口径）；远程任务的这个值来自被控端（见 remoteBounds）。
  const limitProviderId = authoritativeBounds?.providerId
    ?? localRouteBounds?.providerId
    ?? (deviceId ? null : providerId ?? null);
  const modelLimitView = useModelContextLimit(
    model && limitProviderId && !deviceId
      ? { agent: makerAgent, providerId: limitProviderId, modelId: model }
      : null,
  );
  // main 返回的 modelLimit 是权威值（它就是 tighterBudget 用的那个）；renderer 自读只作兜底。
  const modelLimit = authoritativeBounds
    ? (authoritativeBounds.modelLimit ?? null)
    : (typeof modelLimitView.limit === 'number' && modelLimitView.limit > 0
      ? modelLimitView.limit
      : null);

  // 有效默认档 = 「跟随默认」在运行期真正得到的窗口。main 的 resolveConfiguredContextWindow 在
  // **没有任务预算**时用的就是模型级「上下文上限」（它同时是用户强行解开路由配置的逃生口，
  // 刻意不按目录夹），只有它为空时才落到目录默认窗口。所以这里不能用 min(默认, 上限)：
  // 自定义连接未声明窗口时目录默认只有 200K 兜底，而会话实际跑在模型级上限 1.05M 上，
  // 用 min 会让 chip 报 200K、与圆环和运行期打架（用户实测报障）。
  // 生效窗口以 main / 被控端**申报**的为准（同一套 resolveConfiguredContextWindow 的结果）。
  //
  // **老被控端根本不申报这两个字段**（`effectiveWindowsReported === false`）：不能把「缺省」
  // 读成「无上限」—— 目录没声明 contextWindowMax 时那样会让 modelLimit 顶成物理上限，而被控端
  // 运行期还会被 `contextWindow` 夹一次（实测：200K 的路由，远程菜单却给出 800K 档）。所以
  // 老端退回保守口径「只允许收紧」：默认档 = min(目录默认, 模型级上限)，物理上限 = 目录默认。
  const effectiveWindowsReported = authoritativeBounds?.effectiveWindowsReported === true;
  const conservativeWindow = defaultWindow !== null && modelLimit !== null
    ? Math.min(defaultWindow, modelLimit)
    : (modelLimit ?? defaultWindow);
  const effectiveMaxWindow = effectiveWindowsReported
    ? (authoritativeBounds?.maxEffectiveWindow ?? maxWindow)
    : (maxWindow ?? defaultWindow);
  // 百分比分母只看**申报的上限**（生效上限 / 目录申报上限）；`maxWindow ?? defaultWindow`
  // 那个兜底只用来夹已存值 —— 默认窗口不是上限，未核实路由可以真的跑在它之上。
  const reportedMaxWindow = effectiveWindowsReported
    ? (authoritativeBounds?.maxEffectiveWindow ?? maxWindow)
    : maxWindow;
  const ceiling = [effectiveMaxWindow, modelLimit]
    .filter((value): value is number => typeof value === 'number' && value > 0)
    .reduce<number | null>((min, value) => (min === null || value < min ? value : min), null);
  // 「模型默认」档的真实含义 = 清掉任务预算后跟随默认会得到的窗口，由 main / 被控端算好下发；
  // 老被控端不申报时取保守值（见上）。
  const effectiveDefaultWindow = effectiveWindowsReported
    ? (authoritativeBounds?.defaultEffectiveWindow ?? (modelLimit ?? defaultWindow))
    : conservativeWindow;

  // 已存值可能来自手改偏好文件（写入口拦不住已存在的数据）：先按同一口径归一化，
  // 否则会在选项里补出一个「点了必失败」的档（update 入口对非整数直接拒绝）。
  //
  // 来源是**权威边界**里的 `budget`（main / 被控端从偏好文件读出，与档位表同源）：
  // 预算是 main 侧偏好条目而不是会话列，远程会话拿不到被控端的库，所以不再从会话快照读。
  // 提交成功后先本地记账（隧道/落盘完成前 UI 立即显示新档），边界刷新回来一致即清除。
  // 乐观记账只在**同一个会话（同一设备）**内有效：预算是偏好文件里按 sessionId 存的条目、
  // 与路由无关，所以切模型/来源/引擎不该丢掉它（否则刷新回来前会闪回旧档）；但同一张卡被换到
  // 别的会话/设备时必须立刻失效，否则旧值会一直盖住新上下文的权威 budget。
  // `confirmedAt` = 写入确实落地的时刻；只有在这之后回来的权威回答才有资格清它 —— 提交前发出、
  // 之后才回来的那次请求（以及路由切换命中旧缓存）不能把刚写的值改回去。
  const budgetScopeKey = `${deviceId ?? 'local'}|${sessionId}`;
  const [optimisticBudget, setOptimisticBudget] = useState<
    { scopeKey: string; value: number | null; confirmedAt: number } | undefined
  >(undefined);
  const storedBudget = useMemo(() => {
    if (optimisticBudget && optimisticBudget.scopeKey === budgetScopeKey) return optimisticBudget.value;
    return normalizeContextWindowBudget(authoritativeBounds?.budget ?? null);
  }, [optimisticBudget, budgetScopeKey, authoritativeBounds?.budget]);
  useEffect(() => {
    if (!optimisticBudget) return;
    if (optimisticBudget.scopeKey !== budgetScopeKey) {
      setOptimisticBudget(undefined);
      return;
    }
    if (normalizeContextWindowBudget(authoritativeBounds?.budget ?? null) === optimisticBudget.value) {
      setOptimisticBudget(undefined);
      return;
    }
    // 提交已确认，且这次权威回答发生在确认之后：以权威值收口。对方设备改了值、被夹紧、
    // 或这条路由的查询失败返回 null（老被控端/隧道抖动）都走这里，避免旧值永久盖着权威值。
    if (boundsFetchedAt >= optimisticBudget.confirmedAt) setOptimisticBudget(undefined);
  }, [optimisticBudget, budgetScopeKey, authoritativeBounds?.budget, boundsFetchedAt]);

  // 每行显示的百分比都按**同一个基准**算（与档位推导同源）：默认档因此显示 `100% · 1.05M`
  // 而不是「绝对值在前」，旧值补的当前档也有百分比 —— 行的形态与颜色在整列里保持一个样式。
  const tierBase = useMemo(() => {
    // 三个上限（生效上限 / 目录申报上限 / 模型级上限）都没有 = 这条路由**没有已知上限**：
    // 典型是自定义连接未声明窗口，目录只有 200K 兜底，而未核实路由会照单接受更大的预算。
    // 这时不能拿默认窗口当分母 —— 已存的更大预算会显示成「500%」，还暗示「默认档就是顶格」。
    // 基准未知就走既有的「只显绝对值」形态（percent === null 分支）。
    if (reportedMaxWindow === null && modelLimit === null) return null;
    const base = resolveContextWindowBudgetBase({
      defaultWindow: effectiveDefaultWindow,
      maxWindow: reportedMaxWindow,
      modelLimit,
    });
    // 默认档永远不该超过 100%：万一拿到自相矛盾的边界（默认档 > 上限），取两者更大的一个
    // 当分母 —— 宁可让上限档显示成不到 100%，也不打出 >100% 的行。
    return base === null || effectiveDefaultWindow === null
      ? base
      : Math.max(base, effectiveDefaultWindow);
  }, [effectiveDefaultWindow, reportedMaxWindow, modelLimit]);

  const options = useMemo(() => {
    if (effectiveDefaultWindow === null) return [];
    // 档位表的上限 = main 会对**显式任务预算**夹的那个数：min(申报上限, 模型级上限)。
    // 刻意不用 tierBase（它含 max(…, 默认档) 的抬升）：未核实路由的默认档可以合法高于
    // 声明上限（模型级上限是「路由配错了」的逃生口，写 null 就会真的生效），但 main 仍会把
    // 任何显式预算夹到声明上限 —— 用抬升后的基准出 250K/500K 档，运行期只会得到 200K，
    // 窗口与输入价带一起说谎（Greptile P1，2026-09-24）。
    // 默认档高于上限时，只有它那一行的百分比按 max(上限, 默认档) 算（见 tierBase），
    // 菜单不会出现运行期达不到的档位。
    // 老被控端维持原口径：只允许收紧，基准就是那个保守上限，不拿默认档去抬。
    const base = buildContextWindowBudgetOptions(effectiveWindowsReported
      ? { defaultWindow: effectiveDefaultWindow, maxWindow: reportedMaxWindow, modelLimit }
      : { defaultWindow: effectiveDefaultWindow, maxWindow: effectiveMaxWindow, modelLimit });
    // 已保存的预算可能不在当前档位集合里（目录默认值变过、或它来自模型级上限口径）。
    // 补一条当前档，避免单选组没有匹配项而显示成空；同样按上限夹紧，否则单选组会
    // 凭空多出比有效值更大的档。
    // 远程拿不到边界时若已存着一个更大的预算（此前有边界时放大的，或别的控制端写的），
    // 仍然把它补成当前档：单选组需要一项匹配已存值，否则界面没有选中项；选中它等于无变化、
    // 不会写库，菜单里的说明针对的是「这里**提供**哪些档」，不是「当前值是多少」。
    const raw = storedBudget ?? effectiveDefaultWindow;
    const current = ceiling === null ? raw : Math.min(raw, ceiling);
    if (base.some((option) => option.tokens === current)) return base;
    // 已存值可能不在比例档里（旧固定档、或目录上限变过）：只按绝对值补一项，
    // **不套百分比标签**（避免「显示 50%、实际 48.8%」的误导）。
    return [...base, { tokens: current, kind: 'current' as const }].sort(
      (a, b) => a.tokens - b.tokens,
    );
  }, [storedBudget, effectiveDefaultWindow, effectiveMaxWindow, effectiveWindowsReported, reportedMaxWindow, modelLimit, ceiling]);

  useEffect(() => {
    if (options.length === 0) return;
    const raw = authoritativeBounds?.budget;
    if (raw !== null && raw !== undefined && raw < 1_000) {
      // 非法值只可能来自手改偏好文件 / 旧数据；运行时会被 main 收敛，这里只留日志线索。
      console.warn('[context-window-budget] ignoring out-of-range saved budget', { budget: raw });
    }
  }, [authoritativeBounds?.budget, options.length]);

  // 当前档位的绝对值（早退之前就算出：Tab 停靠点的 effect 是 hook，必须在早退之前）。
  const selectedTokens = storedBudget === null
    ? effectiveDefaultWindow
    : ceiling === null ? storedBudget : Math.min(storedBudget, ceiling);
  // 单选组的 Tab 停靠点跟着选中档走（首次打开落在当前档上，而不是永远落在第一行）。
  useEffect(() => {
    const checkedIndex = options.findIndex((option) => option.tokens === selectedTokens);
    if (checkedIndex >= 0) setTierTabStopIndex(checkedIndex);
  }, [options, selectedTokens]);

  if (effectiveDefaultWindow === null || options.length === 0 || selectedTokens === null) return null;

  const agent = agentKind === 'cc' ? 'claude-code' : agentKind;
  const quote = getModelPriceQuote(gatewayPricing, providerId, model, agent)
    ?? getModelPriceQuote(referencePricing, providerId, model, agent);

  // 当前档位占基准的百分比：与卡片行同一口径（默认档 = 100%）。
  const selectedPercent = contextWindowBudgetTierPercent(selectedTokens, tierBase);
  /**
   * 方向键在单选组内移动**焦点**（不提交）：`role="radio"` 语义下方向键必须能动，
   * 而每次提交都会落库并可能触发活实例重建 —— 扫过一遍档位不该连写好几次库。
   * 选中仍由 Enter / Space / 点击完成（与之前 Radix 菜单的键盘行为一致）。
   * 焦点可能落在行上（键盘打开 + Tab）或浮层容器上（Radix 默认聚焦内容）：
   * 两种情况都按“当前行 → 选中行 → 停靠点”的顺序推出起点。
   */
  const handleTierKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = tierRowRefs.current.filter((row): row is HTMLButtonElement => row !== null);
    if (rows.length === 0) return;
    const activeIndex = rows.findIndex((row) => row === document.activeElement);
    const checkedIndex = options.findIndex((option) => option.tokens === selectedTokens);
    const base = activeIndex >= 0 ? activeIndex : checkedIndex >= 0 ? checkedIndex : tierTabStopIndex;
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = base + 1;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = base - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next === null) return;
    event.preventDefault();
    const wrapped = ((next % rows.length) + rows.length) % rows.length;
    setTierTabStopIndex(wrapped);
    rows[wrapped].focus();
  };
  const shrinkWarning = selectedTokens < contextTokens && contextTokens > 0;

  const commit = async (tokens: number): Promise<void> => {
    // 选中「有效默认档」上报 null（跟随默认，不快照当前值）。
    const next = tokens === effectiveDefaultWindow ? null : tokens;
    if (next === storedBudget) return;
    if (committing) return;
    setCommitting(true);
    try {
      if (deviceId) {
        // device-link 远程任务：会话的库与运行实例都在被控端，必须走隧道命令；
        // 写本机的镜像库不会生效，还会被下一次镜像覆盖。
        await window.electronAPI.deviceLink.invoke(deviceId, 'maker:set-context-window-budget', [
          sessionId,
          next,
        ]);
      } else {
        await sessionService.update(sessionId, { contextWindowBudget: next });
      }
      // 提交后失效缓存：被控端/主进程可能刚更新了该路由的上限，下次开菜单要拿最新的。
      // 乐观值打上确认时刻（写入已经落地），随后这次 refresh 的结果（fetchedAt 必定晚于它）
      // 才有资格把它收口 —— 之前 in-flight 的查询会被 effect 的 cancelled 丢弃，不会误清新值。
      setOptimisticBudget({ scopeKey: budgetScopeKey, value: next, confirmedAt: Date.now() });
      refreshBounds();
    } catch (error) {
      const unsupported = extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
      toast.error(
        unsupported
          ? t('ccAgent.contextWindowBudget.remoteUnsupported')
          : t('ccAgent.contextWindowBudget.saveFailed'),
      );
      console.warn('[context-window-budget] save failed', {
        sessionId,
        remote: Boolean(deviceId),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCommitting(false);
    }
  };

  const isDisabled = disabled || committing;



  return (
    <Popover
      modal={false}
      open={cardOpen}
      onOpenChange={(open) => {
        if (open) {
          // 键盘/点击打开（指针不在触发器上）与悬浮打开走同一个开卡入口。
          if (!cardPointerInsideRef.current) cardOpenSourceRef.current = 'focus';
          refreshBoundsIfStale();
          cardHandleRef.current?.request();
          setCardOpen(true);
          return;
        }
        closeCard();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          // 刻意不用原生 `disabled`：那会把触发器整个移出 Tab 序列 —— 用户实测 Tab 到左边
          // 用量卡后就再也回不到本卡。只读任务（readOnly）或提交中不该连「看一眼当前档位」
          // 都做不到；落档能力由档位行自己 disabled 拦住（与 TodaySpendChip 同一套
          // 「可聚焦、可展开」的底栏卡片语义）。
          aria-disabled={isDisabled || undefined}
          data-context-window-budget-chip
          onPointerDown={() => { openedByPointerRef.current = true; }}
          onKeyDown={() => { openedByPointerRef.current = false; }}
          // 与底栏的用量 chip（TodaySpendChip）保持一致：展开/收起只由 hover、焦点与
          // outside-click 驱动，**点击不当作开关** —— `preventDefault` 让 Radix 的 toggle
          // 不执行；否则悬浮展开后一点就收起，两张底栏卡片交互不一致（用户报障）。
          // 点进来的来源按指针/键盘区分：指针路径必须“不抢焦点”（否则鼠标用户会看到蓝框）。
          onClick={(event) => {
            event.preventDefault();
            openCard(openedByPointerRef.current ? 'hover' : 'focus');
          }}
          onPointerEnter={() => {
            cardPointerInsideRef.current = true;
            scheduleCardOpen();
          }}
          onPointerLeave={() => {
            cardPointerInsideRef.current = false;
            scheduleCardClose();
          }}
          // 视觉上没有数值，当前值必须进可访问名，否则读屏无从得知现在是多少。
          aria-label={t('ccAgent.contextWindowBudget.triggerLabel', {
            window: formatTokenCount(selectedTokens),
          })}
          className={cn(
            // 与右下角用量 chip（`TodaySpendChip`：货币符号 + 金额）同一套视觉：同高 `h-5`、
            // 同字号字重 `text-12 font-medium leading-none`、同颜色 `--msg-tool-card-chevron`
            // （hover 提亮到 `foreground`）、同 `tabular-nums`；符号与数值同色，不做双色拼贴。
            'inline-flex h-5 shrink-0 items-center rounded-full text-12 font-medium leading-none tabular-nums',
            'text-[var(--msg-tool-card-chevron)] transition-colors hover:text-foreground',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            // 只读/提交中仍然可聚焦可展开，但把“不可改”表现在外观上。
            isDisabled && 'cursor-default opacity-50',
          )}
        >
          {/* `opacity-60` 与货币 chip 的符号完全一致（`TodaySpendChip`：`<span className="tabular-nums
              opacity-60">{symbol}</span>`）—— 同一个色值再压 40%，两枚符号在底栏里才是同一种灰。
              百分比不压暗：它就是这一档的"值"，与货币 chip 里金额的位置对应。 */}
          <span className="shrink-0 text-11 leading-none opacity-60" aria-hidden="true">
            {CONTEXT_WINDOW_MARKER}
          </span>
          {selectedPercent !== null && (
            <span className="shrink-0">{t('ccAgent.contextWindowBudget.optionPercent', {
              percent: selectedPercent,
            })}</span>
          )}
        </button>
      </PopoverTrigger>
      {/* 浮层挂到触发器**紧跟其后**的宿主：portal 到 body 时卡片在文档最末，焦点一旦
          进卡就再 Tab 不回底栏（用户实测）—— DOM 顺序必须与视觉顺序一致。 */}
      <div ref={setCardPortalHost} className="contents" />
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        portalContainer={cardPortalHost}
        className="min-w-[220px] p-1.5"
        // 悬浮打开不抢焦点（鼠标用户不该被移走焦点）；键盘打开保持 Radix 默认，方向键照常可用。
        onOpenAutoFocus={(event) => {
          if (cardOpenSourceRef.current === 'hover') event.preventDefault();
        }}
        // 指针路径（悬浮或点击）关闭时不要把焦点还给触发器：Chrome 会把这次程序化聚焦判成
        // `:focus-visible`，鼠标用户会看到一圈蓝框（用户报障）。键盘路径保持原行为 ——
        // focus 指示必须留下，只是不给鼠标。
        onCloseAutoFocus={(event) => {
          if (cardOpenSourceRef.current === 'hover' || openedByPointerRef.current) {
            event.preventDefault();
          }
        }}
        onPointerEnter={() => {
          cardPointerInsideRef.current = true;
          cancelCardClose();
        }}
        onPointerLeave={() => {
          cardPointerInsideRef.current = false;
          scheduleCardClose();
        }}
        // 键盘导航挂在浮层上（而不是只挂在单选组上）：Radix 打开时把焦点给浮层容器，
        // 按键会落在容器而不是行上，挂在组上会收不到。
        onKeyDown={handleTierKeyDown}
      >
        <div className="px-2 pb-1.5 pt-1">
          <p className="text-12 font-medium text-[var(--text-primary)]">
            {t('ccAgent.contextWindowBudget.menuTitle')}
          </p>
          {/* 说明与注解统一用 `--text-secondary`：即「用量明细」卡（货币符号那个界面）里
              说明文字的同一档灰（实测 rgb(111,111,111)），面板里只有一种「次要灰」。 */}
          {/* 字号/字重与「用量明细」卡（货币符号那个界面）同一套：标题 12/500、说明 12/400、
              档位行 13/500、注解 12/400 —— 面板与卡片读起来才是同一个系统。 */}
          <p className="mt-0.5 text-12 font-normal leading-[1.5] text-[var(--text-secondary)]">
            {t('ccAgent.contextWindowBudget.menuHint')}
          </p>
          {deviceId && !authoritativeBounds && (
            // 没能从被控端拿到该路由的边界（老版本 / 拉取失败）：这里只能给出不超过
            // 本地已知默认值的档位，文案必须如实说明，不能留给用户“能调大”的预期。
            <p className="mt-0.5 text-12 font-normal leading-[1.5] text-[var(--text-secondary)]">
              {t('ccAgent.contextWindowBudget.remoteTightenOnly')}
            </p>
          )}
          {disabled && (
            // 只读任务：卡片照常可展开（能看当前档位与价带），但档位行不可选 —— 给出原因，
            // 而不是把所有行默默变灰。
            <p className="mt-0.5 text-12 font-normal leading-[1.5] text-[var(--text-secondary)]">
              {t('ccAgent.contextWindowBudget.readOnlyHint')}
            </p>
          )}
        </div>
        <div role="radiogroup" aria-label={t('ccAgent.contextWindowBudget.menuTitle')}>
          {options.map((option, index) => {
            const price = inputPriceAtTokens(quote, option.tokens);
            return (
              <TierRow
                key={`${option.kind}-${option.tokens}`}
                tokens={option.tokens}
                checked={option.tokens === selectedTokens}
                disabled={isDisabled}
                onSelect={() => void commit(option.tokens)}
                // roving tabindex：单选组只占一个 Tab 位，其余行用方向键抵达。
                tabIndex={index === tierTabStopIndex ? 0 : -1}
                buttonRef={(node) => {
                  tierRowRefs.current[index] = node;
                }}
                onFocus={() => setTierTabStopIndex(index)}
              >
                {(() => {
                  // 形态统一：`百分比 · 绝对值`（默认档 = 100% · 模型默认窗口）；百分比与绝对值
                  // 同色（继承行色），不再出现「灰百分比 + 白绝对值」的两色拼贴。基准未知时只显绝对值。
                  const percent = contextWindowBudgetTierPercent(option.tokens, tierBase);
                  const absolute = formatTokenCount(option.tokens);
                  return (
                    <span className="tabular-nums">
                      {percent === null ? absolute : `${t('ccAgent.contextWindowBudget.optionPercent', { percent })} · ${absolute}`}
                    </span>
                  );
                })()}
                {option.kind === 'default' && (
                  <span className="ml-1.5 text-12 font-normal text-[var(--text-secondary)]">
                    {t('ccAgent.contextWindowBudget.optionDefault')}
                  </span>
                )}
                {price && (
                  <span className="ml-auto pl-3 text-12 font-normal tabular-nums text-[var(--text-secondary)]">
                    {t('ccAgent.contextWindowBudget.inputPrice', { price })}
                  </span>
                )}
              </TierRow>
            );
          })}
        </div>
        {shrinkWarning && (
          <p className="mx-2 mt-1.5 border-t border-[var(--border-default)] pt-1.5 text-11 leading-[1.5] text-[var(--warning-fg)]">
            {t('ccAgent.contextWindowBudget.shrinkWarning', {
              used: formatTokenCount(contextTokens),
            })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 档位行：单选语义（`role="radio"` + `aria-checked`）的按钮。
 *
 * 为什么不用 Radix 的菜单项：卡片要**指针悬浮**就展开（与货币 chip 的「用量明细」卡同一交互），
 * 而 Radix 菜单在展开时会把焦点抢进内容 —— 鼠标扫过底栏不该发生这种事；Popover 不抢焦点，
 * 行的几何/选中标记沿用原菜单项（`pl-8 pr-2 py-1.5 rounded-sm` + 左侧实心圆点）。
 */
function TierRow({
  tokens,
  checked,
  disabled,
  onSelect,
  tabIndex,
  buttonRef,
  onFocus,
  children,
}: {
  tokens: number;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** roving tabindex：只有停靠点为 0，组内其余行为 −1。 */
  tabIndex: number;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      data-token={tokens}
      ref={buttonRef}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onSelect}
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-left text-13 font-medium',
        'outline-none transition-colors hover:bg-sidebar-item-hover',
        'focus-visible:bg-sidebar-item-hover focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        {checked && (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M7.49991 0.876953C3.84222 0.876953 0.877075 3.8421 0.877075 7.49979C0.877075 11.1575 3.84222 14.123 7.49991 14.123C11.1576 14.123 14.1227 11.1575 14.1227 7.49979C14.1227 3.8421 11.1576 0.876953 7.49991 0.876953ZM7.49991 1.82695C10.6329 1.82695 13.1727 4.3668 13.1727 7.49979C13.1727 10.6328 10.6329 13.173 7.49991 13.173C4.36692 13.173 1.82708 10.6328 1.82708 7.49979C1.82708 4.3668 4.36692 1.82695 7.49991 1.82695ZM7.49991 4.37695C5.77492 4.37695 4.37708 5.77479 4.37708 7.49979C4.37708 9.22479 5.77492 10.623 7.49991 10.623C9.22491 10.623 10.6227 9.22479 10.6227 7.49979C10.6227 5.77479 9.22491 4.37695 7.49991 4.37695Z"
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
            />
          </svg>
        )}
      </span>
      {children}
    </button>
  );
}

/**
 * 档位 / chip 的 token 缩写 —— **窗口尺寸口径**：`250000 → "250K"`、`262144 → "262.1K"`、
 * `1048576 → "1.05M"`。
 *
 * 这与**用量族**（`formatCompactTokens`、以及会话页圆环 tooltip 与压缩确认框本地那份：小写或大写
 * 单位但恒一位小数）刻意不是同一套：窗口尺寸要能分辨量级接近的档位，一位小数会把 1,048,576 读成
 * "1.0M"、把 1,050,000 读成 "1.1M"（看上去差 10%，实际差 0.14%），用户无从判断真值。
 * 圆环是**用量指示器**（已用 / 窗口 + 百分比），它的取整属于用量口径，不要拿这份去"统一"它。
 *
 * 比例档的值是精确百分比，这里只做显示缩写（K 段一位小数、M 段两位、去掉末尾 0），
 * 落库与生效的仍是精确整数。
 */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const trim = (text: string): string =>
    text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) {
    // 进位不跨档：999,999 的一位小数会读成 "1000K"（量级已是 M、单位却还停在 K）。
    if (n / 1_000 >= 999.95) return `${trim((n / 1_000_000).toFixed(2))}M`;
    return `${trim((n / 1_000).toFixed(1))}K`;
  }
  return String(Math.round(n));
}

/** 边界有 TTL：被控端（或本机设置）改了模型级上限后，重开菜单能拿到新值而不是永久陈旧。 */
const BOUNDS_TTL_MS = 60_000;

interface CachedBounds {
  value: SessionContextWindowBounds | null;
  fetchedAt: number;
}

/** 同一 (设备, 会话, 引擎, 来源, 模型) 的边界短时缓存，避免每次开合菜单都打一次隧道/主进程。 */
const boundsCache = new Map<string, CachedBounds>();

function cacheKey(
  deviceId: string | undefined,
  sessionId: string,
  model: string,
  agentKind: string,
  providerId: string | null,
): string {
  // agentKind 必须进 key：同一会话跨引擎切换且 model 字符串相同时，两个引擎的路由/上限不同。
  // providerId 同理：同一模型跨来源的物理上限与模型级上限都可能不同（否则会把 A 来源的边界
  // 当成 B 来源的权威值缓存下来）。
  return `${deviceId ?? 'local'} ${sessionId} ${agentKind} ${providerId ?? '-'} ${model}`;
}

/** 仅供测试：清掉跨用例的缓存（生产里键包含设备/会话，不会这样复用）。 */
export function resetRemoteContextWindowBoundsCache(): void {
  boundsCache.clear();
}

/**
 * 任务窗口档位表的权威边界。本地经 main 的 `maker:get-context-window-bounds` handler，
 * 远程经 device-link 的同名 channel（被控端算）——两侧同一口径，所以本地/远程共用一条路径。
 *
 * 查询必须带上**界面上正在显示的路由**（`agentKind` / `providerId` / `model`）：延迟切换期间
 * 会话行还是旧路由，不带上路由会被按旧模型回答，档位表与显示值一起停在旧模型上。
 *
 * 拿不到时返回 null：调用方必须退回「只允许收紧」，不能拿本机目录的值冒充被控端。
 */
export function useSessionContextWindowBounds(
  deviceId: string | undefined,
  sessionId: string,
  model: string,
  agentKind: MakerAgentKindWire,
  providerId?: string | null,
): {
  bounds: SessionContextWindowBounds | null;
  /** 当前键那份权威回答的落盘时刻（0 = 还没拿到过）；调用方用它判断回答是否晚于自己的提交。 */
  boundsFetchedAt: number;
  refresh: () => void;
  refreshIfStale: () => void;
} {
  const key = cacheKey(deviceId, sessionId, model, agentKind, providerId ?? null);
  const [boundsState, setBoundsState] = useState<{
    key: string;
    value: SessionContextWindowBounds | null;
    fetchedAt: number;
  }>(() => {
    const cached = boundsCache.get(key);
    return { key, value: cached?.value ?? null, fetchedAt: cached?.fetchedAt ?? 0 };
  });
  // 会话/模型切换时**渲染期**就换锚（缓存命中直接派生，不必等 effect），避免闪现上一个
  // 会话的上限；in-flight 结果按 key 丢弃。fetchedAt 一并暴露：调用方（chip 的乐观记账）
  // 要判断「这次权威回答是不是发生在我提交之后」，否则拿旧回答清掉刚写的新值。
  const bounds = boundsState.key === key
    ? boundsState.value
    : (boundsCache.get(key)?.value ?? null);
  const boundsFetchedAt = boundsState.key === key
    ? boundsState.fetchedAt
    : (boundsCache.get(key)?.fetchedAt ?? 0);
  // 渲染期只读，写入放在 effect 里（并发渲染/StrictMode 重放时渲染期写 ref 是反模式）。
  const activeKeyRef = useRef(key);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    activeKeyRef.current = key;
    if (!model || !sessionId) {
      setBoundsState({ key, value: null, fetchedAt: 0 });
      return;
    }
    const cached = boundsCache.get(key);
    if (cached && reloadToken === 0 && Date.now() - cached.fetchedAt < BOUNDS_TTL_MS) {
      setBoundsState({ key, value: cached.value, fetchedAt: cached.fetchedAt });
      return;
    }
    let cancelled = false;
    void (async () => {
      // 路由随查询一起上报：被控端/主进程按**显示路由**解析边界，而不是按会话行。
      const route = { agent: agentKind, providerId: providerId ?? null, model };
      try {
        const view = deviceId
          ? await window.electronAPI.deviceLink.invoke(
              deviceId, 'maker:get-context-window-bounds', [sessionId, route],
            )
          : await window.electronAPI.maker.getSessionContextWindowBounds(sessionId, route);
        const resolved = normalizeSessionContextWindowBounds(view);
        const fetchedAt = Date.now();
        boundsCache.set(key, { value: resolved, fetchedAt });
        if (!cancelled && activeKeyRef.current === key) setBoundsState({ key, value: resolved, fetchedAt });
      } catch {
        // 老被控端 → CHANNEL_NOT_ALLOWED，或隧道/主进程瞬时失败：缓存 null（TTL 内不重试），
        // UI 退回「只允许收紧」，由菜单里的说明如实告知。
        const fetchedAt = Date.now();
        boundsCache.set(key, { value: null, fetchedAt });
        if (!cancelled && activeKeyRef.current === key) setBoundsState({ key, value: null, fetchedAt });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, key, sessionId, model, agentKind, providerId, reloadToken]);

  const refresh = useCallback(() => {
    boundsCache.delete(key);
    setReloadToken((token) => token + 1);
  }, [key]);
  // 开菜单时只在「没缓存 / TTL 过期」才重拉：否则每次开合菜单都是一次隧道 invoke（弱网可感知）。
  const refreshIfStale = useCallback(() => {
    const cached = boundsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < BOUNDS_TTL_MS) return;
    setReloadToken((token) => token + 1);
  }, [key]);
  return { bounds, boundsFetchedAt, refresh, refreshIfStale };
}
