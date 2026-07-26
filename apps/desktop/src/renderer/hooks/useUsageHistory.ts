/**
 * useUsageHistory — 首页用量仪表盘的数据 hook。
 *
 * 数据通道: electronAPI.maker.usage.getHistory({days}) — main 侧聚合好
 * (热力图日列表 + streak + 异常 + 按模型拆分), renderer 只渲染。
 *
 * 首帧策略 (设计规范第 7 条 "杜绝跳变/空白帧"):
 *   - 上次成功的 payload 按账号持久化在 localStorage, hook 初始化时同步 hydrate —
 *     app 启动后卡片与页面其它部分同帧出现, 不会"过一会突然弹出"。
 *   - 快照是昨天的也先照常渲染 (数字几乎不变), 真实数据到了静默覆盖。
 *
 * 刷新策略:
 *   - mount 拉一次; module-local cache 让路由重挂载瞬时有数据
 *   - 订阅 onTodaySpendChanged (Claude $) + onTodayTokensChanged (Codex token) 作为
 *     "有新消费"信号, ~2s debounce 后重拉 (push payload 本身不用, 只当触发器)
 *   - paused=true (卡片收起) 时不订阅消费推送 — 收起用户的 per-turn 重拉成本归零;
 *     mount / 展开瞬间仍各拉一次, 摘要行不会陈旧
 *   - 数据未变时跳过快照写入与监听通知 (cache 引用不变 → 不触发重渲染)
 *   - main 侧为了不阻塞首帧, 冷启动可能在价格表就绪前返回 (Codex 行 estimatedCostUsd
 *     缺失) — 检测到这种情况时安排一次延迟重拉补齐估算金额 (每次加载至多一次)。
 */

import { useEffect, useState } from 'react';
import {
  addCompatibleRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  usdMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney';

export interface UsageHistoryModel {
  agentKind: 'claude-code' | 'codex';
  model: string;
  money: RegionalMoney;
  estimatedMoney: RegionalMoney | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** 每日 × 模型明细 — 右栏堆叠柱状图分段。 */
export interface UsageHistoryModelDay {
  day: string;
  agentKind: 'claude-code' | 'codex';
  model: string;
  money: RegionalMoney;
  apiMoney: RegionalMoney;
  subscriptionEstimateMoney: RegionalMoney;
  tokens: number;
}

export interface UsageHistoryPayload {
  generatedAt: number;
  todayKey: string;
  stale?: boolean;
  estimatesPending?: boolean;
  /** tokens: 当日合计 (旧快照可能缺该字段, 消费端用 ?? 0 兜底)。 */
  days: Array<{ day: string; money: RegionalMoney; tokens?: number }>;
  /** 近 30 天每日 × 模型明细 (旧快照缺该字段时补 [])。 */
  modelDaily: UsageHistoryModelDay[];
  models: UsageHistoryModel[];
  streak: { current: number; longest: number };
  totals: {
    today: RegionalMoney;
    last30Days: RegionalMoney;
    last30DaysWithEstimatedValue: RegionalMoney;
    last30DaysEstimatedValue: RegionalMoney;
    todayTokens: number;
    last30DaysTokens: number;
  };
  anomaly: { isAnomalous: boolean; trailing7DayAvg: RegionalMoney | null };
}

/** 热力图窗口: 20 周 = 140 天。 */
const HISTORY_WINDOW_DAYS = 140;
const REFRESH_DEBOUNCE_MS = 2000;
/** 价格表冷启动未就绪时的补拉延迟 (对齐 main 侧 5s fetch 超时 + 余量)。 */
const PRICING_RETRY_DELAY_MS = 6000;
/** main 返回 stale 磁盘快照时的补拉延迟: 让后台聚合先完成, 同时保持更新感知。 */
const STALE_RETRY_DELAY_MS = 800;
// v2 后缀:币种语义改为跟随来源(默认 USD)后,旧构建快照里的金额可能带错标
// CNY——直接换 key 让旧快照失效,首帧宁可空态也不闪现错单位;旧 key 顺手清理。
const SNAPSHOT_STORAGE_KEY = 'homeUsageDashboard.lastPayload.v2';
const LEGACY_SNAPSHOT_STORAGE_KEY = 'homeUsageDashboard.lastPayload';
const DEFAULT_SCOPE_KEY = 'anonymous';

function storageKeyForScope(scopeKey: string): string {
  return `${SNAPSHOT_STORAGE_KEY}.${encodeURIComponent(scopeKey)}`;
}

interface StoredUsageHistoryDay {
  day?: unknown;
  money?: unknown;
  costUsd?: unknown;
  tokens?: unknown;
}

interface StoredUsageHistoryModelDay {
  day?: unknown;
  agentKind?: unknown;
  model?: unknown;
  money?: unknown;
  amountUsd?: unknown;
  apiMoney?: unknown;
  apiCostUsd?: unknown;
  subscriptionEstimateMoney?: unknown;
  subscriptionEstimateUsd?: unknown;
  tokens?: unknown;
}

interface StoredUsageHistoryModel {
  agentKind?: unknown;
  model?: unknown;
  money?: unknown;
  costUsd?: unknown;
  estimatedMoney?: unknown;
  estimatedCostUsd?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreateTokens?: unknown;
}

interface StoredUsageHistoryPayload {
  generatedAt?: unknown;
  todayKey?: unknown;
  stale?: unknown;
  estimatesPending?: unknown;
  days?: unknown;
  modelDaily?: unknown;
  models?: unknown;
  streak?: unknown;
  totals?: unknown;
  anomaly?: unknown;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isAgentKind(value: unknown): value is UsageHistoryModel['agentKind'] {
  return value === 'claude-code' || value === 'codex';
}

function readSnapshot(scopeKey: string): UsageHistoryPayload | null {
  try {
    localStorage.removeItem(
      `${LEGACY_SNAPSHOT_STORAGE_KEY}.${encodeURIComponent(scopeKey)}`,
    );
    const raw = localStorage.getItem(storageKeyForScope(scopeKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredUsageHistoryPayload;
    // 最小结构校验 — 大结构对不上才丢弃; 旧版快照缺 token 字段时补 0 继续用,
    // 避免升级后首启空一帧 (首帧照常渲染, ~200ms 后真实数据静默覆盖)。
    if (!Array.isArray(parsed.days) || !Array.isArray(parsed.models)) return null;
    if (
      !parsed.totals ||
      typeof parsed.totals !== 'object' ||
      Array.isArray(parsed.totals) ||
      !parsed.streak ||
      typeof parsed.streak !== 'object' ||
      Array.isArray(parsed.streak) ||
      !parsed.anomaly ||
      typeof parsed.anomaly !== 'object' ||
      Array.isArray(parsed.anomaly)
    ) {
      return null;
    }
    const totals = parsed.totals as Record<string, unknown>;
    const streak = parsed.streak as Record<string, unknown>;
    const anomaly = parsed.anomaly as Record<string, unknown>;
    const legacyActual = (value: unknown): RegionalMoney =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? legacyUsdMoney(value)
        : zeroUsageMoney();
    const legacyEstimate = (value: unknown): RegionalMoney =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? usdMoney(value, 'value-estimate', 'subscription-value')
        : zeroUsageMoney('value-estimate');

    const days = (parsed.days as StoredUsageHistoryDay[])
      .filter((row) => typeof row?.day === 'string')
      .map((row) => ({
        day: row.day as string,
        money: normalizeRegionalMoney(row.money) ?? legacyActual(row.costUsd),
        tokens: finiteNumber(row.tokens),
      }));
    const modelDaily = (Array.isArray(parsed.modelDaily) ? parsed.modelDaily : [])
      .filter(
        (row: StoredUsageHistoryModelDay) =>
          typeof row?.day === 'string' &&
          typeof row.model === 'string' &&
          isAgentKind(row.agentKind),
      )
      .map((row: StoredUsageHistoryModelDay): UsageHistoryModelDay => ({
        day: row.day as string,
        agentKind: row.agentKind as UsageHistoryModelDay['agentKind'],
        model: row.model as string,
        money:
          normalizeRegionalMoney(row.money) ??
          (row.agentKind === 'codex'
            ? legacyEstimate(row.amountUsd)
            : legacyActual(row.amountUsd)),
        apiMoney: normalizeRegionalMoney(row.apiMoney) ?? legacyActual(row.apiCostUsd),
        subscriptionEstimateMoney:
          normalizeRegionalMoney(row.subscriptionEstimateMoney) ??
          legacyEstimate(row.subscriptionEstimateUsd),
        tokens: finiteNumber(row.tokens),
      }));
    const models = (parsed.models as StoredUsageHistoryModel[])
      .filter(
        (row) =>
          typeof row?.model === 'string' &&
          isAgentKind(row.agentKind),
      )
      .map((row): UsageHistoryModel => ({
        agentKind: row.agentKind as UsageHistoryModel['agentKind'],
        model: row.model as string,
        money: normalizeRegionalMoney(row.money) ?? legacyActual(row.costUsd),
        estimatedMoney:
          normalizeRegionalMoney(row.estimatedMoney) ??
          (typeof row.estimatedCostUsd === 'number'
            ? legacyEstimate(row.estimatedCostUsd)
            : null),
        inputTokens: finiteNumber(row.inputTokens),
        outputTokens: finiteNumber(row.outputTokens),
        cacheReadTokens: finiteNumber(row.cacheReadTokens),
        cacheCreateTokens: finiteNumber(row.cacheCreateTokens),
      }));
    const today = normalizeRegionalMoney(totals.today) ?? legacyActual(totals.today);
    const last30Days =
      normalizeRegionalMoney(totals.last30Days) ?? legacyActual(totals.last30Days);
    const last30DaysEstimatedValue =
      normalizeRegionalMoney(totals.last30DaysEstimatedValue) ??
      legacyEstimate(totals.last30DaysEstimatedValue);
    const last30DaysWithEstimatedValue =
      normalizeRegionalMoney(totals.last30DaysWithEstimatedValue) ??
      (last30DaysEstimatedValue.amount > 0
        ? (addCompatibleRegionalMoney(
            [last30Days, last30DaysEstimatedValue],
          ) ?? last30Days)
        : last30Days);
    const trailing7DayAvg =
      anomaly.trailing7DayAvg === null
        ? null
        : normalizeRegionalMoney(anomaly.trailing7DayAvg) ??
          legacyActual(anomaly.trailing7DayAvg);

    return {
      generatedAt: finiteNumber(parsed.generatedAt, Date.now()),
      todayKey: typeof parsed.todayKey === 'string' ? parsed.todayKey : '',
      stale: parsed.stale === true,
      estimatesPending: parsed.estimatesPending === true,
      days,
      modelDaily,
      models,
      streak: {
        current: finiteNumber(streak.current),
        longest: finiteNumber(streak.longest),
      },
      totals: {
        today,
        last30Days,
        last30DaysWithEstimatedValue,
        last30DaysEstimatedValue,
        todayTokens: finiteNumber(totals.todayTokens),
        last30DaysTokens: finiteNumber(totals.last30DaysTokens),
      },
      anomaly: {
        isAnomalous: anomaly.isAnomalous === true,
        trailing7DayAvg,
      },
    };
  } catch {
    return null;
  }
}

function writeSnapshot(scopeKey: string, p: UsageHistoryPayload): void {
  try {
    localStorage.setItem(storageKeyForScope(scopeKey), JSON.stringify(p));
  } catch {
    /* 写不进就下次启动慢一帧, 不影响功能 */
  }
}

/** 数据等价比较用的序列化 (generatedAt 每次都变, 排除)。 */
function serializeForCompare(p: UsageHistoryPayload): string {
  return JSON.stringify({ ...p, generatedAt: 0 });
}

interface UsageHistoryScopeState {
  cache: UsageHistoryPayload | null;
  cacheSerialized: string | null;
  inflight: Promise<UsageHistoryPayload | null> | null;
  loadSeq: number;
  pricingRetryDone: boolean;
  staleRetryTimer: ReturnType<typeof setTimeout> | null;
  pricingRetryTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(p: UsageHistoryPayload | null) => void>;
  statusListeners: Set<(refreshing: boolean) => void>;
  refreshing: boolean;
}

const scopes = new Map<string, UsageHistoryScopeState>();

function normalizeScopeKey(userId?: string | null): string {
  return userId || DEFAULT_SCOPE_KEY;
}

function getScope(scopeKey: string): UsageHistoryScopeState {
  let state = scopes.get(scopeKey);
  if (!state) {
    const snapshot = readSnapshot(scopeKey);
    state = {
      cache: snapshot,
      cacheSerialized: snapshot ? serializeForCompare(snapshot) : null,
      inflight: null,
      loadSeq: 0,
      pricingRetryDone: false,
      staleRetryTimer: null,
      pricingRetryTimer: null,
      listeners: new Set<(p: UsageHistoryPayload | null) => void>(),
      statusListeners: new Set<(refreshing: boolean) => void>(),
      refreshing: false,
    };
    scopes.set(scopeKey, state);
  }
  return state;
}

function cancelScopeTimers(scope: UsageHistoryScopeState): void {
  if (scope.staleRetryTimer) {
    clearTimeout(scope.staleRetryTimer);
    scope.staleRetryTimer = null;
  }
  if (scope.pricingRetryTimer) {
    clearTimeout(scope.pricingRetryTimer);
    scope.pricingRetryTimer = null;
  }
}

function deactivateScopeIfUnused(scope: UsageHistoryScopeState): void {
  if (scope.listeners.size > 0 || scope.statusListeners.size > 0) return;
  cancelScopeTimers(scope);
  scope.pricingRetryDone = false;
  scope.inflight = null;
  scope.loadSeq += 1;
  setRefreshing(scope, false);
}

function setRefreshing(scope: UsageHistoryScopeState, next: boolean): void {
  if (scope.refreshing === next) return;
  scope.refreshing = next;
  for (const fn of scope.statusListeners) fn(scope.refreshing);
}

async function load(scopeKey: string, opts?: { forceRefresh?: boolean; resetPricingRetry?: boolean }): Promise<UsageHistoryPayload | null> {
  const scope = getScope(scopeKey);
  if (scope.inflight && !opts?.forceRefresh) return scope.inflight;
  if (opts?.resetPricingRetry) scope.pricingRetryDone = false;
  const seq = ++scope.loadSeq;
  setRefreshing(scope, true);
  scope.inflight = window.electronAPI.maker.usage
    .getHistory({ days: HISTORY_WINDOW_DAYS, ...(opts?.forceRefresh ? { forceRefresh: true } : {}) })
    .then((res) => {
      if (seq === scope.loadSeq) scope.inflight = null;
      if (!res || typeof res !== 'object') return null;
      if (seq !== scope.loadSeq) return scope.cache;
      const next = res as UsageHistoryPayload;
      const nextForCache = { ...next, stale: false };
      if (next.stale) {
        const nextSerialized = serializeForCompare(nextForCache);
        if (nextSerialized !== scope.cacheSerialized) {
          scope.cache = nextForCache;
          scope.cacheSerialized = nextSerialized;
          writeSnapshot(scopeKey, scope.cache);
          for (const fn of scope.listeners) fn(scope.cache);
        }
        if (!scope.staleRetryTimer) {
          scope.staleRetryTimer = setTimeout(() => {
            scope.staleRetryTimer = null;
            if (scope.listeners.size === 0 && scope.statusListeners.size === 0) return;
            void load(scopeKey);
          }, STALE_RETRY_DELAY_MS);
        }
        return scope.cache;
      }
      if (next.estimatesPending) {
        if (!scope.pricingRetryDone) {
          scope.pricingRetryDone = true;
          scope.pricingRetryTimer = setTimeout(() => {
            scope.pricingRetryTimer = null;
            if (scope.listeners.size === 0 && scope.statusListeners.size === 0) return;
            void load(scopeKey, { forceRefresh: true });
          }, PRICING_RETRY_DELAY_MS);
        }
        return scope.cache;
      }
      scope.pricingRetryDone = false;
      // dirty-check: 数据未变 (仅 generatedAt 不同) → 不换 cache 引用、不写快照、
      // 不通知监听 — 等价数据不触发重渲染与 JSON 落盘
      const nextSerialized = serializeForCompare(nextForCache);
      if (nextSerialized !== scope.cacheSerialized) {
        scope.cache = nextForCache;
        scope.cacheSerialized = nextSerialized;
        writeSnapshot(scopeKey, scope.cache);
        for (const fn of scope.listeners) fn(scope.cache);
      }
      return scope.cache;
    })
    .catch(() => {
      if (seq === scope.loadSeq) scope.inflight = null;
      return null;
    })
    .finally(() => {
      if (seq === scope.loadSeq && !scope.staleRetryTimer) setRefreshing(scope, false);
    });
  return scope.inflight;
}

export function useUsageHistory(opts?: { paused?: boolean; userId?: string | null }): {
  history: UsageHistoryPayload | null;
  refreshing: boolean;
} {
  const paused = opts?.paused ?? false;
  const scopeKey = normalizeScopeKey(opts?.userId);
  const scope = getScope(scopeKey);
  const [historyState, setHistoryState] = useState<{ scopeKey: string; value: UsageHistoryPayload | null }>(() => ({
    scopeKey,
    value: scope.cache,
  }));
  const [isRefreshing, setIsRefreshing] = useState(scope.refreshing);

  useEffect(() => {
    const activeScope = getScope(scopeKey);
    const setScopedHistory = (value: UsageHistoryPayload | null) => {
      setHistoryState({ scopeKey, value });
    };
    activeScope.listeners.add(setScopedHistory);
    activeScope.statusListeners.add(setIsRefreshing);
    // 注册后立即用当前 cache 对齐一次: useState(cache) 是 render 时的快照, 若别处的
    // load() 在 render 与本 effect 之间更新了 cache, 且后续 load 都命中 dirty-check
    // (不再广播), 本实例会停在旧值。引用相同时 React 自动 bail out, 无重渲染成本。
    setScopedHistory(activeScope.cache);
    setIsRefreshing(activeScope.refreshing);
    // mount 与 paused→false (展开瞬间) 都拉一次 — 折叠摘要 / 图表数据都保持新鲜。
    // 收起时跳过后续 push 订阅, 避免每个 turn 触发后台重拉。
    void load(scopeKey);

    // paused (卡片收起): 不订阅消费推送, 收起用户的 per-turn 重拉成本归零
    if (paused) {
      return () => {
        activeScope.listeners.delete(setScopedHistory);
        activeScope.statusListeners.delete(setIsRefreshing);
        deactivateScopeIfUnused(activeScope);
      };
    }

    // 任一 agent 有新消费 → debounce 重拉 (turn 密集结束时合并成一次)
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load(scopeKey, { forceRefresh: true, resetPricingRetry: true });
      }, REFRESH_DEBOUNCE_MS);
    };
    const offSpend = window.electronAPI.maker.usage.onTodaySpendChanged(scheduleRefresh);
    const offTokens = window.electronAPI.maker.usage.onTodayTokensChanged(scheduleRefresh);
    const offPricing = window.electronAPI.maker.usage.onModelPricingChanged(scheduleRefresh);

    return () => {
      activeScope.listeners.delete(setScopedHistory);
      activeScope.statusListeners.delete(setIsRefreshing);
      deactivateScopeIfUnused(activeScope);
      if (timer) clearTimeout(timer);
      offSpend();
      offTokens();
      offPricing();
    };
  }, [paused, scopeKey]);

  return {
    history: historyState.scopeKey === scopeKey ? historyState.value : scope.cache,
    refreshing: isRefreshing,
  };
}
