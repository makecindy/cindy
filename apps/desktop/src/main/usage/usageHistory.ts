/**
 * usageHistory — 首页用量仪表盘的聚合查询 (main 侧, renderer 只渲染)。
 *
 * 数据源:
 *   - daily_spend: 日总额 canonical 来源 → 热力图 / streak / 今日 / 近 30 天总额 / 异常检测
 *   - daily_model_usage: 按模型拆分 (近 30 天), Codex 行美元在这里用 modelPricing 估算
 *     (读取时折算, 不在写入时冻结价格 — 价格表会变且离线时拿不到)
 *
 * 缓存策略:
 *   - 生产入口 readUsageHistory() 先 hydrate userData/cache/usage-history.json。
 *   - 有缓存时立即返回 stale payload, 后台刷新并写回磁盘; renderer 保持"更新中"感知并短轮询补 fresh。
 *   - 无缓存时才走同步聚合, 成功后落盘。纯函数 readUsageHistoryWith() 不带 IO 缓存, 便于单测。
 *
 * streak / anomaly / 估算全部是导出的纯函数, 单测不需要 DB / Electron。
 * 日期一律用本地时区 day key (localDayKey 同口径); renderer 以 payload.todayKey 为锚,
 * 不自己取系统日期。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getAllSpendDays, localDayKey } from '../localDb/dailySpend';
import { getModelUsageSince, type DailyModelUsageRow } from '../localDb/dailyModelUsage';
import { getCurrentDbClientUserId } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  getCodexSubscriptionValuePrice,
  getModelPricing,
  getSubscriptionDirectValuePrice,
  isModelPricingRefreshInFlight,
  type ModelPricingMap,
} from './modelPricing';
import { computePriceQuoteTurnMoney } from './turnCostCalculator';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  getModelPriceQuote,
  regionalizeModelPriceQuote,
} from '../../shared/modelPriceQuote.js';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  regionalAmountFromUsdReference,
  regionalCurrencyForRegion,
  type ModelPriceQuote,
  type RegionalMoney,
  zeroRegionalMoney,
} from '../../shared/regionalMoney.js';

const log = createLogger('usageHistory');

/** 活跃日判定阈值: 当日花费 ≥ $0.01 才算"用过"。 */
const ACTIVE_DAY_MIN_USD = 0.01;
/** 异常判定: 今日 > 2× 前 7 日均值 且 今日 ≥ $1 (绝对下限防 $0.10 vs $0.02 误报)。 */
const ANOMALY_FACTOR = 2;
const ANOMALY_MIN_TODAY_USD = 1;
/** 异常基线最少需要的活跃日数 (前 7 天里 < 3 天有消费 → 基线不可信, 不判异常)。 */
const ANOMALY_MIN_ACTIVE_DAYS = 3;
/** 模型拆分统计窗口 (天)。 */
const MODEL_WINDOW_DAYS = 30;
/** 等价格表的最长预算 (ms) — 缓存命中时是同步快返, 只有冷启动网络 fetch 会触及。 */
const PRICING_WAIT_BUDGET_MS = 200;
const DISK_CACHE_VERSION = 2;
const DISK_CACHE_FILE = 'usage-history.json';
/** 后台刷新完成后, renderer 的短轮询能拿到 fresh payload, 避免 stale 状态自循环。 */
const MEMORY_FRESH_MS = 10_000;
const CODEX_BILLING_MODEL_SUFFIX_RE = /#billing=(api|subscription)$/;

export interface UsageHistoryDay {
  day: string;
  money: RegionalMoney;
  /** 当日 token 合计 (daily_model_usage 口径, 表上线前的历史日为 0)。 */
  tokens: number;
}

export interface UsageHistoryModel {
  agentKind: 'claude-code' | 'codex';
  model: string;
  /** SDK 实报美元 (Claude); Codex 恒 0。 */
  money: RegionalMoney;
  /** Codex: token × 价格表估算; 模型无价格条目或价格表不可用时 null。Claude 恒 null。 */
  estimatedMoney: RegionalMoney | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** 每日 × 模型的一行明细 — 右栏堆叠柱状图的分段数据。 */
export interface UsageHistoryModelDay {
  day: string;
  agentKind: 'claude-code' | 'codex';
  model: string;
  /** 可比金额: Claude 实报 $; Codex 为价格表估算 (无价格 → 0, 只出现在图例 token 行)。 */
  money: RegionalMoney;
  /** 实际 API / gateway 计费金额。 */
  apiMoney: RegionalMoney;
  /** 订阅 token 价值估算金额。 */
  subscriptionEstimateMoney: RegionalMoney;
  tokens: number;
}

export interface UsageHistoryPayload {
  generatedAt: number;
  /** 本地时区今日 key — renderer 所有日期推算以此为锚。 */
  todayKey: string;
  /**
   * true = 来自 main 侧持久化缓存, 后台正在刷新。
   * renderer 应先展示这份数据, 同时保留"更新中"状态并短延迟重拉。
   */
  stale?: boolean;
  /**
   * true = 本次聚合遇到 Codex 用量, 但价格表尚未就绪。
   * renderer 应延迟重拉, 避免先显示不含订阅估算的误导性 30 日图表。
   */
  estimatesPending: boolean;
  /** day >= today-windowDays 的日总额 (稀疏, 无消费日无行; renderer 补格)。 */
  days: UsageHistoryDay[];
  /** 近 30 天每日 × 模型明细 (堆叠柱状图分段用; 表上线前的历史日无行)。 */
  modelDaily: UsageHistoryModelDay[];
  /** 近 30 天按 (agentKind, model) 聚合, 按可比金额降序。 */
  models: UsageHistoryModel[];
  streak: { current: number; longest: number };
  totals: {
    today: RegionalMoney;
    last30Days: RegionalMoney;
    /**
     * 近 30 天展示口径: 实际 API / gateway spend + Codex OAuth 订阅 token 价值估算。
     * 订阅估算按模型明细单独叠加, 不会把已计入 API spend 的模型行重复算入。
     */
    last30DaysWithEstimatedValue: RegionalMoney;
    /** last30DaysWithEstimatedValue - last30Days, 用于 UI 标注"含估算"。 */
    last30DaysEstimatedValue: RegionalMoney;
    /** 今日 token 合计 (input+output+cacheRead+cacheCreate, daily_model_usage 口径; 表上线后才有)。 */
    todayTokens: number;
    /** 近 30 天 token 合计 (同上口径; 0 = 还没积累出数据, renderer 据此隐藏 token 段)。 */
    last30DaysTokens: number;
  };
  anomaly: { isAnomalous: boolean; trailing7DayAvg: RegionalMoney | null };
}

/** YYYY-MM-DD → 前一天 (本地时区语义, 纯字符串进出)。 */
export function prevDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) - 1);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** YYYY-MM-DD → N 天前的 day key。 */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + deltaDays);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/**
 * 连续活跃天数。activeDays 为活跃日 key 集合 (无序可重复均可)。
 * current: 从今天往回数; 今天还没消费不打断 (从昨天起算), 但昨天也断了就是 0。
 */
export function computeStreaks(
  activeDays: Iterable<string>,
  todayKey: string,
): { current: number; longest: number } {
  const set = new Set(activeDays);
  if (set.size === 0) return { current: 0, longest: 0 };

  // current: 锚点 = 今天 (活跃) 或昨天 (今天尚未消费的宽限)
  let current = 0;
  let cursor = set.has(todayKey) ? todayKey : prevDayKey(todayKey);
  while (set.has(cursor)) {
    current += 1;
    cursor = prevDayKey(cursor);
  }

  // longest: 对有序日列表线性扫
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    run = prev !== null && prevDayKey(day) === prev ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }
  return { current, longest };
}

/**
 * 异常检测: 今日花费 vs 前 7 个日历日 (不含今日) 的均值。
 * 缺日按 0 计入均值; 7 天里活跃日 < 3 → 基线不可信, 返回 avg=null 且不判异常。
 */
export function computeAnomaly(
  spendByDay: ReadonlyMap<string, number>,
  todayKey: string,
  thresholds: {
    activeDayMin?: number;
    anomalyMinToday?: number;
  } = {},
): { isAnomalous: boolean; trailing7DayAvg: number | null } {
  const activeDayMin = thresholds.activeDayMin ?? ACTIVE_DAY_MIN_USD;
  const anomalyMinToday =
    thresholds.anomalyMinToday ?? ANOMALY_MIN_TODAY_USD;
  let sum = 0;
  let activeCount = 0;
  for (let i = 1; i <= 7; i++) {
    const v = spendByDay.get(shiftDayKey(todayKey, -i)) ?? 0;
    sum += v;
    if (v >= activeDayMin) activeCount += 1;
  }
  if (activeCount < ANOMALY_MIN_ACTIVE_DAYS) {
    return { isAnomalous: false, trailing7DayAvg: null };
  }
  const avg = sum / 7;
  const today = spendByDay.get(todayKey) ?? 0;
  return {
    isAnomalous: today >= anomalyMinToday && today > ANOMALY_FACTOR * avg,
    trailing7DayAvg: avg,
  };
}

/** 测试注入用的数据读取依赖。 */
export interface UsageHistoryDeps {
  getAllSpendDays(): Promise<Array<{ day: string; money: RegionalMoney }>>;
  getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]>;
  getModelPricing(): Promise<ModelPricingMap | null>;
  isModelPricingRefreshInFlight(): boolean;
  todayKey(): string;
}

const defaultDeps: UsageHistoryDeps = {
  getAllSpendDays,
  getModelUsageSince,
  getModelPricing,
  isModelPricingRefreshInFlight,
  todayKey: () => localDayKey(),
};

interface DiskCachePayload {
  version?: number;
  optsKey?: string;
  payload?: unknown;
}

let cachedHistory: UsageHistoryPayload | null = null;
let cachedHistoryOptsKey: string | null = null;
let hydrateInFlight: Promise<UsageHistoryPayload | null> | null = null;
let hydratedOptsKeys = new Set<string>();
let refreshInFlightByOptsKey = new Map<string, Promise<UsageHistoryPayload | null>>();
let refreshGenerationByOptsKey = new Map<string, number>();

function diskCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', DISK_CACHE_FILE);
}

function optsKey(opts?: { days?: number }): string {
  const days = Math.min(366, Math.max(1, Math.floor(opts?.days ?? 140)));
  const userId = getCurrentDbClientUserId() ?? 'anonymous';
  return `user=${encodeURIComponent(userId)}|days=${days}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateUsageHistoryPayload(value: unknown): UsageHistoryPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Partial<UsageHistoryPayload>;
  if (!isFiniteNumber(payload.generatedAt) || !isString(payload.todayKey)) return null;
  if (!Array.isArray(payload.days) || !Array.isArray(payload.modelDaily) || !Array.isArray(payload.models)) return null;
  if (!payload.streak || !payload.totals || !payload.anomaly) return null;
  if (!isFiniteNumber(payload.streak.current) || !isFiniteNumber(payload.streak.longest)) return null;
  if (
    !normalizeRegionalMoney(payload.totals.today) ||
    !normalizeRegionalMoney(payload.totals.last30Days) ||
    !normalizeRegionalMoney(payload.totals.last30DaysWithEstimatedValue) ||
    !normalizeRegionalMoney(payload.totals.last30DaysEstimatedValue) ||
    !isFiniteNumber(payload.totals.todayTokens) ||
    !isFiniteNumber(payload.totals.last30DaysTokens)
  ) {
    return null;
  }
  if (
    typeof payload.anomaly.isAnomalous !== 'boolean' ||
    !(
      normalizeRegionalMoney(payload.anomaly.trailing7DayAvg) ||
      payload.anomaly.trailing7DayAvg === null
    )
  ) {
    return null;
  }
  return {
    generatedAt: payload.generatedAt,
    todayKey: payload.todayKey,
    stale: Boolean(payload.stale),
    estimatesPending: Boolean(payload.estimatesPending),
    days: payload.days as UsageHistoryDay[],
    modelDaily: payload.modelDaily as UsageHistoryModelDay[],
    models: payload.models as UsageHistoryModel[],
    streak: payload.streak,
    totals: payload.totals,
    anomaly: payload.anomaly,
  };
}

function freshPayload(payload: UsageHistoryPayload): UsageHistoryPayload {
  return { ...payload, stale: false };
}

function stalePayload(payload: UsageHistoryPayload): UsageHistoryPayload {
  return { ...payload, stale: true };
}

function isMemoryFresh(payload: UsageHistoryPayload): boolean {
  return Date.now() - payload.generatedAt < MEMORY_FRESH_MS;
}

function displayModelName(model: string): string {
  return model.replace(CODEX_BILLING_MODEL_SUFFIX_RE, '');
}

/** `#billing=subscription` 标记行 —— Claude / Codex 订阅共用同一后缀语义。 */
function isSubscriptionUsageModel(model: string): boolean {
  return model.endsWith('#billing=subscription');
}

export function codexApiUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=api`;
}

export function codexSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/** Claude 订阅轮的按模型记账 key(register.ts 消费)—— 与 codex 同一订阅标记后缀。 */
export function claudeSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/**
 * 订阅行的估算价选取,按 agent 分流:
 *   - codex → 订阅直连(chatgpt/ / xai/)静态价 →
 *     既有 getCodexSubscriptionValuePrice(网关价 + OpenAI 静态兜底表)
 *   - claude-code → 网关价表精确条目(带 cache 档价)→ Anthropic 家族牌价兜底
 * 两级都 miss → undefined(该行只显示 token,不臆造金额)。
 */
function getSubscriptionValuePriceFor(
  agentKind: 'claude-code' | 'codex',
  model: string,
  pricing: ModelPricingMap | null,
): ModelPriceQuote | undefined {
  if (agentKind === 'codex') {
    const quote =
      getSubscriptionDirectValuePrice(model) ??
      getCodexSubscriptionValuePrice(model, pricing);
    return quote
      ? regionalizeModelPriceQuote(quote, CURRENT_CINDY_REGION)
      : undefined;
  }
  const quote = getModelPriceQuote(pricing, 'anthropic', model);
  return quote
    ? regionalizeModelPriceQuote(quote, CURRENT_CINDY_REGION)
    : undefined;
}

async function hydrateFromDisk(expectedOptsKey: string): Promise<UsageHistoryPayload | null> {
  if (hydratedOptsKeys.has(expectedOptsKey)) {
    return cachedHistoryOptsKey === expectedOptsKey ? cachedHistory : null;
  }
  if (!hydrateInFlight) {
    hydrateInFlight = (async () => {
      try {
        const raw = await fs.readFile(diskCachePath(), 'utf8');
        const parsed = JSON.parse(raw) as DiskCachePayload;
        if (parsed.version !== DISK_CACHE_VERSION || parsed.optsKey !== expectedOptsKey) return null;
        const payload = validateUsageHistoryPayload(parsed.payload);
        if (!payload) return null;
        cachedHistory = freshPayload(payload);
        cachedHistoryOptsKey = expectedOptsKey;
        return cachedHistory;
      } catch (err) {
        const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code !== 'ENOENT') {
          log.debug('hydrate usage history cache failed:', err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        hydratedOptsKeys.add(expectedOptsKey);
        hydrateInFlight = null;
      }
    })();
  }
  const payload = await hydrateInFlight;
  return cachedHistoryOptsKey === expectedOptsKey ? payload : null;
}

async function writeDiskCache(expectedOptsKey: string, payload: UsageHistoryPayload): Promise<void> {
  const file = diskCachePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const diskPayload: DiskCachePayload = {
      version: DISK_CACHE_VERSION,
      optsKey: expectedOptsKey,
      payload: freshPayload(payload),
    };
    await fs.writeFile(file, JSON.stringify(diskPayload), 'utf8');
  } catch (err) {
    log.debug('write usage history cache failed:', err instanceof Error ? err.message : String(err));
  }
}

function rememberFreshUsageHistory(expectedOptsKey: string, payload: UsageHistoryPayload): void {
  cachedHistory = payload;
  cachedHistoryOptsKey = expectedOptsKey;
  if (!payload.estimatesPending) void writeDiskCache(expectedOptsKey, payload);
}

function nextRefreshGeneration(expectedOptsKey: string): number {
  const next = (refreshGenerationByOptsKey.get(expectedOptsKey) ?? 0) + 1;
  refreshGenerationByOptsKey.set(expectedOptsKey, next);
  return next;
}

function isLatestRefreshGeneration(expectedOptsKey: string, generation: number): boolean {
  return refreshGenerationByOptsKey.get(expectedOptsKey) === generation;
}

export interface UsageHistoryReadOptions {
  days?: number;
  /**
   * true = 事件触发的刷新, 需要绕过 10s 内存快返, 立即重新聚合 DB。
   * mount / 展开仍使用 stale-while-refresh 快路径保证首帧速度。
   */
  forceRefresh?: boolean;
}

async function refreshUsageHistory(expectedOptsKey: string, opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload | null> {
  if (opts?.forceRefresh) {
    refreshInFlightByOptsKey.delete(expectedOptsKey);
    const generation = nextRefreshGeneration(expectedOptsKey);
    return readUsageHistoryWith(defaultDeps, opts)
      .then((payload) => {
        const next = freshPayload(payload);
        if (isLatestRefreshGeneration(expectedOptsKey, generation)) {
          rememberFreshUsageHistory(expectedOptsKey, next);
        }
        return next;
      })
      .catch((err) => {
        log.debug('refresh usage history failed:', err instanceof Error ? err.message : String(err));
        return null;
      });
  }
  const current = refreshInFlightByOptsKey.get(expectedOptsKey);
  if (current) return current;
  const generation = nextRefreshGeneration(expectedOptsKey);
  const nextRefresh = readUsageHistoryWith(defaultDeps, opts)
      .then((payload) => {
        const next = freshPayload(payload);
        if (isLatestRefreshGeneration(expectedOptsKey, generation)) {
          rememberFreshUsageHistory(expectedOptsKey, next);
        }
        return next;
      })
      .catch((err) => {
        log.debug('refresh usage history failed:', err instanceof Error ? err.message : String(err));
        return null;
      })
      .finally(() => {
        refreshInFlightByOptsKey.delete(expectedOptsKey);
      });
  refreshInFlightByOptsKey.set(expectedOptsKey, nextRefresh);
  return nextRefresh;
}

function refreshUsageHistoryInBackground(expectedOptsKey: string, opts?: UsageHistoryReadOptions): void {
  void refreshUsageHistory(expectedOptsKey, opts);
}

/** 聚合主体 (deps 注入版, 单测用)。 */
export async function readUsageHistoryWith(
  deps: UsageHistoryDeps,
  opts?: UsageHistoryReadOptions,
): Promise<UsageHistoryPayload> {
  const windowDays = Math.min(366, Math.max(1, Math.floor(opts?.days ?? 140)));
  const todayKey = deps.todayKey();

  const allDays = await deps.getAllSpendDays();
  const spendByDay = new Map(
    allDays.map((row) => [row.day, row.money.amount]),
  );
  const zeroActual = () => zeroRegionalMoney(CURRENT_CINDY_REGION);
  const zeroEstimate = () =>
    zeroRegionalMoney(CURRENT_CINDY_REGION, 'value-estimate');
  const addOrZero = (
    values: RegionalMoney[],
    kind: 'actual-cost' | 'value-estimate' = 'actual-cost',
  ): RegionalMoney =>
    addCompatibleRegionalMoney(
      values,
      regionalCurrencyForRegion(CURRENT_CINDY_REGION),
    ) ??
    (kind === 'actual-cost' ? zeroActual() : zeroEstimate());

  const heatmapCutoff = shiftDayKey(todayKey, -(windowDays - 1));
  const modelCutoff = shiftDayKey(todayKey, -(MODEL_WINDOW_DAYS - 1));
  // 一次查询同时服务两个窗口: 热力图 tooltip 的每日 token (heatmap 窗口) 与
  // 模型拆分聚合 (30 天窗口)。取更早的 cutoff (ISO day key 字符串可直接比较)。
  const usageRowsSince = heatmapCutoff < modelCutoff ? heatmapCutoff : modelCutoff;
  const allModelRows = await deps.getModelUsageSince(usageRowsSince);
  const modelRows = allModelRows.filter((r) => r.day >= modelCutoff);

  // 每日 token 合计 → days 的 tooltip 数据。codex-only 日 daily_spend 无行 ($ 只有
  // Claude 记), 也要并进 days, 否则热力图那天 hover 不到 token。
  const tokensByDay = new Map<string, number>();
  for (const row of allModelRows) {
    if (row.day < heatmapCutoff) continue;
    const rowTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens;
    tokensByDay.set(row.day, (tokensByDay.get(row.day) ?? 0) + rowTokens);
  }
  const daysMap = new Map<string, UsageHistoryDay>();
  for (const r of allDays) {
    if (r.day >= heatmapCutoff && r.money.amount > 0) {
      daysMap.set(r.day, { day: r.day, money: r.money, tokens: 0 });
    }
  }
  for (const [day, tokens] of tokensByDay) {
    if (tokens <= 0) continue;
    const existing = daysMap.get(day);
    if (existing) existing.tokens = tokens;
    else daysMap.set(day, { day, money: zeroActual(), tokens });
  }
  const days = [...daysMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  // pricing 不许阻塞首页首帧: 冷启动时 getModelPricing 是一次最长 5s 的网络请求,
  // race 一个短预算 — 没赶上就先按无价格返回 (Codex 行暂显 token 量), 后台 fetch
  // 仍会完成并写 6h 缓存, renderer 下一次刷新 (push 触发) 自然补上估算金额。
  const pricing = await Promise.race([
    deps.getModelPricing(),
    new Promise<null>((resolve) => setTimeout(resolve, PRICING_WAIT_BUDGET_MS, null)),
  ]);
  const hasMissingPendingSubscriptionPrice = modelRows.some((r) =>
    isSubscriptionUsageModel(r.model) &&
    !getSubscriptionValuePriceFor(
      r.agentKind === 'codex' ? 'codex' : 'claude-code',
      displayModelName(r.model),
      pricing,
    ),
  );
  const estimatesPending =
    hasMissingPendingSubscriptionPrice &&
    deps.isModelPricingRefreshInFlight();

  const byKey = new Map<string, UsageHistoryModel>();
  let todayTokens = 0;
  let last30DaysTokens = 0;
  for (const row of modelRows) {
    const rowTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens;
    last30DaysTokens += rowTokens;
    if (row.day === todayKey) todayTokens += rowTokens;
  }
  for (const row of modelRows) {
    const agentKind = row.agentKind === 'codex' ? 'codex' : 'claude-code';
    // claude 订阅行同样带 #billing= 后缀, 展示名统一剥后缀; key 保留原始 model
    // (api / subscription 两个计费维度分行聚合)。
    const model = displayModelName(row.model);
    const key = `${agentKind}\u0000${row.model}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        agentKind,
        model,
        money: zeroActual(),
        estimatedMoney: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      };
      byKey.set(key, agg);
    }
    if (row.money.amount > 0) {
      agg.money =
        agg.money.amount > 0
          ? (addCompatibleRegionalMoney(
              [agg.money, row.money],
              regionalCurrencyForRegion(CURRENT_CINDY_REGION),
            ) ?? row.money)
          : row.money;
    }
    agg.inputTokens += row.inputTokens;
    agg.outputTokens += row.outputTokens;
    agg.cacheReadTokens += row.cacheReadTokens;
    agg.cacheCreateTokens += row.cacheCreateTokens;
  }
  for (const [key, m] of byKey) {
    const modelKey = key.slice(key.indexOf('\u0000') + 1);
    if (m.money.amount === 0 && isSubscriptionUsageModel(modelKey)) {
      m.estimatedMoney = computePriceQuoteTurnMoney(
        m,
        getSubscriptionValuePriceFor(m.agentKind, m.model, pricing),
      );
    }
  }
  const models = [...byKey.values()];

  // 每日 × 模型明细 (30 天窗口) — 堆叠柱状图分段。金额口径与 models 一致:
  // Claude 实报 $, Codex 行按价格表折算 (无价格 → 0, 该模型只出现在图例 token 行)。
  const modelDaily: UsageHistoryModelDay[] = modelRows.map((row) => {
    const agentKind = row.agentKind === 'codex' ? ('codex' as const) : ('claude-code' as const);
    const model = displayModelName(row.model);
    const apiMoney = row.money;
    const subscriptionEstimateMoney =
      apiMoney.amount === 0 && isSubscriptionUsageModel(row.model)
        ? (computePriceQuoteTurnMoney(
            row,
            getSubscriptionValuePriceFor(agentKind, model, pricing),
          ) ?? zeroEstimate())
        : zeroEstimate();
    const money =
      apiMoney.amount > 0 ? apiMoney : subscriptionEstimateMoney;
    return {
      day: row.day,
      agentKind,
      model,
      money,
      apiMoney,
      subscriptionEstimateMoney,
      tokens: row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens,
    };
  });
  // 可比金额 (实报或估算) 降序; 无金额的 token-only 行排最后 (按 token 量降序)
  const comparable = (m: UsageHistoryModel) =>
    m.money.amount > 0 ? m.money.amount : (m.estimatedMoney?.amount ?? -1);
  models.sort((a, b) => {
    const diff = comparable(b) - comparable(a);
    if (diff !== 0) return diff;
    const tokens = (m: UsageHistoryModel) =>
      m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreateTokens;
    return tokens(b) - tokens(a);
  });

  const activeDayMin = regionalAmountFromUsdReference(
    ACTIVE_DAY_MIN_USD,
    CURRENT_CINDY_REGION,
  );
  const anomalyMinToday = regionalAmountFromUsdReference(
    ANOMALY_MIN_TODAY_USD,
    CURRENT_CINDY_REGION,
  );
  const activeDays = allDays
    .filter((row) => row.money.amount >= activeDayMin)
    .map((row) => row.day);
  const last30Cutoff = shiftDayKey(todayKey, -(MODEL_WINDOW_DAYS - 1));
  const last30ActualByDay = new Map<string, RegionalMoney>();
  for (const row of allDays) {
    if (row.day >= last30Cutoff) {
      last30ActualByDay.set(row.day, row.money);
    }
  }
  const last30SubscriptionEstimateByDay = new Map<string, RegionalMoney[]>();
  for (const row of modelDaily) {
    if (row.subscriptionEstimateMoney.amount <= 0) continue;
    const values = last30SubscriptionEstimateByDay.get(row.day) ?? [];
    values.push(row.subscriptionEstimateMoney);
    last30SubscriptionEstimateByDay.set(row.day, values);
  }
  const last30 = addOrZero([...last30ActualByDay.values()]);
  const last30EstimatedValue = addOrZero(
    [...last30SubscriptionEstimateByDay.values()].flat(),
    'value-estimate',
  );
  const last30WithEstimatedValue =
    last30EstimatedValue.amount > 0
      ? (addCompatibleRegionalMoney(
          [last30, last30EstimatedValue],
          regionalCurrencyForRegion(CURRENT_CINDY_REGION),
        ) ?? last30)
      : last30;
  const anomalyRaw = computeAnomaly(spendByDay, todayKey, {
    activeDayMin,
    anomalyMinToday,
  });
  const trailing7Approximate = allDays.some(
    (row) =>
      row.day >= shiftDayKey(todayKey, -7) &&
      row.day < todayKey &&
      row.money.approximate,
  );
  const today =
    allDays.find((row) => row.day === todayKey)?.money ?? zeroActual();

  return {
    generatedAt: Date.now(),
    todayKey,
    estimatesPending,
    days,
    modelDaily,
    models,
    streak: computeStreaks(activeDays, todayKey),
    totals: {
      today,
      last30Days: last30,
      last30DaysWithEstimatedValue: last30WithEstimatedValue,
      last30DaysEstimatedValue: last30EstimatedValue,
      todayTokens,
      last30DaysTokens,
    },
    anomaly: {
      isAnomalous: anomalyRaw.isAnomalous,
      trailing7DayAvg:
        anomalyRaw.trailing7DayAvg === null
          ? null
          : {
              amount: anomalyRaw.trailing7DayAvg,
              currency: today.currency,
              approximate: trailing7Approximate,
              kind: 'actual-cost',
              ...(trailing7Approximate
                ? { estimateReasons: ['legacy-usd'] }
                : {}),
            },
    },
  };
}

/** 生产入口 (usage.ts adapter 注入给 IPC handler)。 */
export async function readUsageHistory(opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload> {
  const key = optsKey(opts);
  if (opts?.forceRefresh) {
    const fresh = await refreshUsageHistory(key, opts);
    if (fresh) return freshPayload(fresh);
    if (cachedHistory && cachedHistoryOptsKey === key) return stalePayload(cachedHistory);
    const diskPayload = await hydrateFromDisk(key);
    if (diskPayload) return stalePayload(diskPayload);
    return emptyUsageHistoryPayload();
  }
  if (cachedHistory && cachedHistoryOptsKey === key) {
    if (refreshInFlightByOptsKey.has(key)) return stalePayload(cachedHistory);
    if (isMemoryFresh(cachedHistory)) return freshPayload(cachedHistory);
    refreshUsageHistoryInBackground(key, opts);
    return stalePayload(cachedHistory);
  }
  const diskPayload = await hydrateFromDisk(key);
  if (diskPayload) {
    refreshUsageHistoryInBackground(key, opts);
    return stalePayload(diskPayload);
  }
  const fresh = await refreshUsageHistory(key, opts);
  return fresh ?? emptyUsageHistoryPayload();
}

/** DB 出错时的兜底空 payload (查询型 handler fallback-data 模式)。 */
export function emptyUsageHistoryPayload(): UsageHistoryPayload {
  const todayKey = localDayKey();
  return {
    generatedAt: Date.now(),
    todayKey,
    stale: false,
    estimatesPending: false,
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: zeroRegionalMoney(CURRENT_CINDY_REGION),
      last30Days: zeroRegionalMoney(CURRENT_CINDY_REGION),
      last30DaysWithEstimatedValue: zeroRegionalMoney(
        CURRENT_CINDY_REGION,
      ),
      last30DaysEstimatedValue: zeroRegionalMoney(
        CURRENT_CINDY_REGION,
        'value-estimate',
      ),
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };
}

export function __resetUsageHistoryCacheForTesting(): void {
  cachedHistory = null;
  cachedHistoryOptsKey = null;
  hydrateInFlight = null;
  hydratedOptsKeys = new Set<string>();
  refreshInFlightByOptsKey = new Map<string, Promise<UsageHistoryPayload | null>>();
  refreshGenerationByOptsKey = new Map<string, number>();
}
