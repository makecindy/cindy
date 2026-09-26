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
 * 设备范围 (device):
 *   - 'local' (默认): 只读本机库, 首页仪表盘沿用。
 *   - 'all': 本机 + 同账号其它电脑的原始行 (peerUsageSync 经 device-link 拉取并缓存),
 *     合并后走同一条聚合链路。设置 → 用量历史默认使用。
 *   - 其它值: 某一台其它电脑的 deviceId, 只聚合该设备的缓存行。
 *   多设备范围在其它设备同步期间返回 stale, renderer 的短轮询据此拿到合并后的结果。
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
import { getSessionUsageSince, getUsageTaskMeta } from '../localDb/dailySessionUsage';
import { getCurrentDbClientUserId } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  getGatewayModelPricing,
  isModelPricingRefreshInFlight,
  type ModelPricingMap,
} from './modelPricing';
import {
  getClaudeSubscriptionValuePrice,
  getCodexProviderSubscriptionValuePrice,
  getCodexSubscriptionValuePrice,
  getReferenceModelPricing,
  getSubscriptionDirectValuePrice,
  readModelPriceOverridesSnapshot,
  type ModelPriceOverridesSnapshot,
} from './referenceModelPricing';
import { computePriceQuoteTurnMoney } from './turnCostCalculator';
import {
  getPeerUsageSync,
  type PeerUsageSnapshot,
  type UsageDeviceSummary,
} from './peerUsageSync';
import type { UsageDeviceRows } from './usageDeviceRows';
import { currentLedgerCurrency } from './ledgerCurrency.js';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  USD_TO_CNY_FIXED_RATE,
  type ModelPriceQuote,
  type MoneyCurrency,
  type RegionalMoney,
  zeroUsageMoney,
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
// v5:日账改为按币种分行后折叠口径变了；v4 快照是用「按区域猜出来的账本币种」折叠出来
//    的聚合值，直接沿用会让升级后的首页继续显示按错币种算出的历史。整份作废重算。
// v4:恢复 CN usage 的 CNY 账本口径，并让订阅 USD 估值按 6.7 投影到 CNY。
const DISK_CACHE_VERSION = 5;
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
  agentKind: 'claude-code' | 'codex' | 'pi';
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
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  /** 可比金额: Claude 实报 $; Codex 为价格表估算 (无价格 → 0, 只出现在图例 token 行)。 */
  money: RegionalMoney;
  /** 实际 API / gateway 计费金额。 */
  apiMoney: RegionalMoney;
  /** 订阅 token 价值估算金额。 */
  subscriptionEstimateMoney: RegionalMoney;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
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
  /** 按 modelDays 窗口返回的每日 × 模型明细 (堆叠柱状图分段用)。 */
  modelDaily: UsageHistoryModelDay[];
  /** 按 modelDays 窗口聚合的 (agentKind, model), 按可比金额降序。 */
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
  /**
   * 多设备范围才有: 参与合并的电脑 (含本机), 供设备选择器与「数据截至」标注。
   * 'local' 范围与旧快照缺省。
   */
  devices?: UsageDeviceSummary[];
  /** true = 正在从其它电脑读取, 结果可能还不含它们的最新数据。 */
  devicesSyncing?: boolean;
  /** 聚合时使用的跨设备数据版本 (main 内部新鲜度判断用)。 */
  peerVersion?: number;
  /** 按 modelDays 窗口返回的每日 × 任务 token (「最耗 token 的任务」按范围统计)。 */
  taskDaily?: UsageHistoryTaskDay[];
  /** taskDaily 涉及任务的元数据。 */
  tasks?: UsageHistoryTask[];
}

export type UsageHistoryDeviceScope = 'local' | 'all' | (string & {});

/** 本机任务的设备键;其它电脑的任务用它的 deviceId。 */
export const LOCAL_TASK_DEVICE = 'local';

/** 「最耗 token 的任务」的每日 × 任务一行。taskKey = `${deviceId}:${sessionId}`。 */
export interface UsageHistoryTaskDay {
  day: string;
  taskKey: string;
  tokens: number;
}

export interface UsageHistoryTask {
  taskKey: string;
  /** LOCAL_TASK_DEVICE 或其它电脑的 deviceId。 */
  deviceId: string;
  sessionId: string;
  title: string;
  model: string;
  providerId: string | null;
  contextTokens: number;
  contextWindow: number;
  /** unix ms */
  lastActiveAt: number;
}

export function usageTaskKey(deviceId: string, sessionId: string): string {
  return `${deviceId}:${sessionId}`;
}

/**
 * 合并多台设备的原始行。同一 (天, agent, 模型, 币种, 金额口径) 的模型行相加,
 * 保持与单机库一致的「每键一行」形状 —— 下游 modelDaily 与柱图按行取值, 不能出现重复键。
 * 日账按天拼接各设备的多币种金额, 折叠仍由聚合链路按账本币种完成。
 */
export function combineUsageDeviceRows(sources: readonly UsageDeviceRows[]): UsageDeviceRows {
  const spendByDay = new Map<string, RegionalMoney[]>();
  const modelByKey = new Map<string, DailyModelUsageRow>();
  for (const source of sources) {
    for (const row of source.spendDays) {
      const monies = spendByDay.get(row.day) ?? [];
      monies.push(...row.monies);
      spendByDay.set(row.day, monies);
    }
    for (const row of source.modelRows) {
      const key = [row.day, row.agentKind, row.model, row.money.currency, row.money.kind].join('\u0000');
      const existing = modelByKey.get(key);
      if (!existing) {
        modelByKey.set(key, { ...row });
        continue;
      }
      existing.money =
        addCompatibleRegionalMoney([existing.money, row.money], row.money.currency) ?? existing.money;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheCreateTokens += row.cacheCreateTokens;
    }
  }
  return {
    spendDays: [...spendByDay.entries()]
      .map(([day, monies]) => ({ day, monies }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    modelRows: [...modelByKey.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    // 任务行需保留设备归属,不在这里合并 —— 由 getTaskUsageSince 按设备分别打键。
    sessionRows: [],
    tasks: [],
  };
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
  getAllSpendDays(): Promise<Array<{ day: string; monies: RegionalMoney[] }>>;
  getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]>;
  /** 每日 × 任务用量;缺省(旧测试替身)视为没有任务数据。 */
  getTaskUsageSince?(
    sinceDayKey: string,
  ): Promise<{ rows: UsageHistoryTaskDay[]; tasks: UsageHistoryTask[] }>;
  getGatewayModelPricing(): Promise<ModelPricingMap | null>;
  getReferenceModelPricing(): ModelPricingMap;
  /** 覆盖记录快照,一次聚合读一份——历史重合并逐行读文件会在慢盘上拖垮 Main 线程。 */
  getModelPriceOverridesSnapshot(): ModelPriceOverridesSnapshot;
  isModelPricingRefreshInFlight(): boolean;
  todayKey(): string;
}

/** 本机任务用量,按 LOCAL_TASK_DEVICE 打上设备键。 */
function localTaskUsage(
  rows: Awaited<ReturnType<typeof getSessionUsageSince>>,
): { rows: UsageHistoryTaskDay[]; tasks: UsageHistoryTask[] } {
  return tagTaskUsage(LOCAL_TASK_DEVICE, rows);
}

function tagTaskUsage(
  deviceId: string,
  usage: { rows: UsageDeviceRows['sessionRows']; tasks: UsageDeviceRows['tasks'] },
): { rows: UsageHistoryTaskDay[]; tasks: UsageHistoryTask[] } {
  return {
    rows: usage.rows.map((row) => ({
      day: row.day,
      taskKey: usageTaskKey(deviceId, row.sessionId),
      tokens: row.tokens,
    })),
    tasks: usage.tasks.map((task) => ({
      ...task,
      taskKey: usageTaskKey(deviceId, task.sessionId),
      deviceId,
    })),
  };
}

const defaultDeps: UsageHistoryDeps = {
  getAllSpendDays,
  getModelUsageSince,
  getTaskUsageSince: async (sinceDayKey) => localTaskUsage(await getSessionUsageSince(sinceDayKey)),
  getGatewayModelPricing,
  getReferenceModelPricing,
  getModelPriceOverridesSnapshot: readModelPriceOverridesSnapshot,
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

function normalizeWindowDays(value: number | 'all' | undefined, fallback: number): number | 'all' {
  if (value === 'all') return 'all';
  return Math.min(366, Math.max(1, Math.floor(value ?? fallback)));
}

function normalizeDeviceScope(value: UsageHistoryDeviceScope | undefined): UsageHistoryDeviceScope {
  return value && value.length > 0 ? value : 'local';
}

function optsKey(opts?: UsageHistoryReadOptions): string {
  const device = normalizeDeviceScope(opts?.device);
  const days = normalizeWindowDays(opts?.days, 140);
  const modelDays = normalizeWindowDays(opts?.modelDays, MODEL_WINDOW_DAYS);
  const userId = getCurrentDbClientUserId() ?? 'anonymous';
  // Keep the pre-window-split key for the default request so existing disk
  // snapshots remain readable. Non-default model windows get their own key.
  const modelSuffix = modelDays === MODEL_WINDOW_DAYS ? '' : `|modelDays=${modelDays}`;
  // 'local' 沿用旧 key, 升级后首页与已有磁盘快照照常命中。
  const deviceSuffix = device === 'local' ? '' : `|device=${encodeURIComponent(device)}`;
  return `user=${encodeURIComponent(userId)}|days=${days}${modelSuffix}${deviceSuffix}`;
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
    ...(Array.isArray(payload.devices) ? { devices: payload.devices } : {}),
    ...(Array.isArray(payload.taskDaily) && Array.isArray(payload.tasks)
      ? { taskDaily: payload.taskDaily, tasks: payload.tasks }
      : {}),
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

/** Pi 订阅轮与其它 agent 共用 billing 后缀，但保留独立 agentKind。 */
export function piSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/**
 * 订阅行的估算价选取,按 agent 分流:
 *   - codex → 订阅直连(chatgpt/ / xai/)registry 参考价 → OpenAI registry 参考价
 *     → Anthropic registry 参考价(Codex 显式选内置 anthropic 的 Claude.ai 订阅轮;
 *     模型 id 只会命中各自 provider 的路由,依次尝试不会串价)
 *   - pi → 先按订阅直连估价(agent=pi,才能命中设置里的 Pi 价格覆盖),
 *     再依次回退 Codex(OpenAI)与 Anthropic registry 参考价
 *     (Pi 可跨三类 provider,按模型 id 路由,依次尝试不会串价)
 *   - claude-code → Anthropic registry 参考价
 * 各级都 miss → undefined(该行只显示 token,不臆造金额)。
 */
export function getSubscriptionValuePriceFor(
  agentKind: 'claude-code' | 'codex' | 'pi',
  model: string,
  pricing: ModelPricingMap | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  if (agentKind === 'codex') {
    return (
      getSubscriptionDirectValuePrice(model, 'codex', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getCodexProviderSubscriptionValuePrice('anthropic', model, pricing, at, overrides)
    );
  }
  if (agentKind === 'pi') {
    return (
      getSubscriptionDirectValuePrice(model, 'pi', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
    );
  }
  return (
    getSubscriptionDirectValuePrice(model, 'claude-code', pricing, at, overrides) ??
    getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
  );
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
  days?: number | 'all';
  /** Model/table aggregation window. `all` is used by Settings → Usage History. */
  modelDays?: number | 'all';
  /** 设备范围, 缺省 'local'。见文件头注释。 */
  device?: UsageHistoryDeviceScope;
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
    return readScopedUsageHistory(opts)
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
  const nextRefresh = readScopedUsageHistory(opts)
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
  const windowDays = normalizeWindowDays(opts?.days, 140);
  const modelWindowDays = normalizeWindowDays(opts?.modelDays, MODEL_WINDOW_DAYS);
  const todayKey = deps.todayKey();

  // 历史聚合只有一个金额口径:兼容当前账本币种的金额保留,无法确定换算语义的
  // 异币种金额在入口丢弃为 0。token 等非金额统计仍保留。
  //
  // 账本币种与写入侧同一事实源(currentLedgerCurrency)：由服务端按账号所属租户下发，
  // 不保证等于发行区域。按区域取会把以 USD 结算的账号在 CN 构建上的每一行判成异币种、
  // 整段归零成不计费。历史遗留的异币种行(换号 / 跨区)仍按 keepCompatibleMoney 归零。
  const [spendDayRows, , pricing] = await Promise.all([
    deps.getAllSpendDays(),
    // Gateway 报价只读内存或账号作用域内的磁盘快照，不发网络请求。必须等它完成，
    // 因为 hydrateFromDisk 还负责恢复同一快照声明的账本币种。
    deps.getGatewayModelPricing(),
    Promise.resolve(deps.getReferenceModelPricing()),
  ]);
  // 必须在上面 pricing 恢复之后再读:hydrateFromDisk 会在磁盘缓存生效的同时回写账本币种,
  // 而 prewarmModelPricing 与首页首次聚合是并发的。先读会拿到构建默认值,把该账号的日账与
  // 模型行全部归零,还可能把这个错结果写进 usage-history 缓存。
  const ledgerCurrency = currentLedgerCurrency();
  // 零值也用账本币种:无消费日的 today/空聚合不能把展示单位翻回默认币种。
  const zeroActual = (): RegionalMoney => ({
    amount: 0,
    currency: ledgerCurrency,
    approximate: false,
    kind: 'actual-cost',
  });
  const zeroEstimate = (): RegionalMoney => ({
    amount: 0,
    currency: ledgerCurrency,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: ['subscription-value'],
  });
  const keepCompatibleMoney = (money: RegionalMoney): RegionalMoney =>
    money.currency === ledgerCurrency
      ? money
      : { ...money, amount: 0, currency: ledgerCurrency };
  const addOrZero = (
    values: RegionalMoney[],
    kind: 'actual-cost' | 'value-estimate' = 'actual-cost',
  ): RegionalMoney =>
    addCompatibleRegionalMoney(
      values.filter((value) => value.currency === ledgerCurrency),
      ledgerCurrency,
    ) ?? (kind === 'actual-cost' ? zeroActual() : zeroEstimate());
  // 日账按币种拆开取回，折叠推迟到这里 —— 与上面等 pricing 是同一个理由：折叠依赖账本
  // 币种，而它要等报价快照恢复才确定。若在 getAllSpendDays 内部折叠，冷启动时会先按
  // 兜底币种把本账号那一行丢掉，等到这里再怎么等也拿不回来。
  // 与 model 行共用 addOrZero，异币种同样归零，两条链路口径一致。
  const allDays = spendDayRows.map((row) => ({
    day: row.day,
    money: addOrZero(row.monies),
  }));
  const spendByDay = new Map(
    allDays.map((row) => [row.day, row.money.amount]),
  );

  const heatmapCutoff = windowDays === 'all' ? null : shiftDayKey(todayKey, -(windowDays - 1));
  const modelCutoff = modelWindowDays === 'all'
    ? null
    : shiftDayKey(todayKey, -(modelWindowDays - 1));
  // 一次查询同时服务两个窗口: 热力图 tooltip 的每日 token (heatmap 窗口) 与
  // 模型拆分聚合 (30 天窗口)。取更早的 cutoff (ISO day key 字符串可直接比较)。
  const usageRowsSince = heatmapCutoff === null || modelCutoff === null
    ? '0000-01-01'
    : heatmapCutoff < modelCutoff
      ? heatmapCutoff
      : modelCutoff;
  const allModelRows = (await deps.getModelUsageSince(usageRowsSince)).map((row) => ({
    ...row,
    money: keepCompatibleMoney(row.money),
  }));
  const modelRows = modelCutoff === null
    ? allModelRows
    : allModelRows.filter((r) => r.day >= modelCutoff);
  const taskUsage = deps.getTaskUsageSince
    ? await deps.getTaskUsageSince(modelCutoff ?? '0000-01-01')
    : null;

  // 每日 token 合计 → days 的 tooltip 数据。codex-only 日 daily_spend 无行 ($ 只有
  // Claude 记), 也要并进 days, 否则热力图那天 hover 不到 token。
  const tokensByDay = new Map<string, number>();
  for (const row of allModelRows) {
    if (heatmapCutoff !== null && row.day < heatmapCutoff) continue;
    const rowTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens;
    tokensByDay.set(row.day, (tokensByDay.get(row.day) ?? 0) + rowTokens);
  }
  const daysMap = new Map<string, UsageHistoryDay>();
  for (const r of allDays) {
    if ((heatmapCutoff === null || r.day >= heatmapCutoff) && r.money.amount > 0) {
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
  // pricing 在函数开头已与消费行并行取好(见那里的 race 注释)。
  // 覆盖记录也在这里读一次快照:缺价检查、模型聚合、每日明细三条遍历共用,
  // 避免历史重合并按 model-day 逐行 stat 覆盖文件。
  const priceOverrides = deps.getModelPriceOverridesSnapshot();
  const hasMissingPendingSubscriptionPrice = modelRows.some((r) =>
    isSubscriptionUsageModel(r.model) &&
    r.money.kind !== 'value-estimate' &&
    !getSubscriptionValuePriceFor(
      r.agentKind === 'codex' ? 'codex' : r.agentKind === 'pi' ? 'pi' : 'claude-code',
      displayModelName(r.model),
      pricing,
      r.day,
      priceOverrides,
    ),
  );
  const estimatesPending =
    hasMissingPendingSubscriptionPrice &&
    deps.isModelPricingRefreshInFlight();

  const byKey = new Map<string, UsageHistoryModel>();
  const subscriptionEstimatesByKey = new Map<string, RegionalMoney[]>();
  let todayTokens = 0;
  let last30DaysTokens = 0;
  for (const row of modelRows) {
    const rowTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens;
    last30DaysTokens += rowTokens;
    if (row.day === todayKey) todayTokens += rowTokens;
  }
  for (const row of modelRows) {
    const agentKind = row.agentKind === 'codex' ? 'codex' : row.agentKind === 'pi' ? 'pi' : 'claude-code';
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
    if (row.money.amount > 0 && row.money.kind === 'actual-cost') {
      agg.money =
        agg.money.amount > 0
          ? (addCompatibleRegionalMoney([agg.money, row.money], ledgerCurrency) ?? row.money)
          : row.money;
    }
    agg.inputTokens += row.inputTokens;
    agg.outputTokens += row.outputTokens;
    agg.cacheReadTokens += row.cacheReadTokens;
    agg.cacheCreateTokens += row.cacheCreateTokens;
    if (isSubscriptionUsageModel(row.model)) {
      const estimate =
        row.money.kind === 'value-estimate' && row.money.amount > 0
          ? row.money
          : row.money.kind !== 'value-estimate' && row.money.amount === 0
            ? computePriceQuoteTurnMoney(
                row,
                getSubscriptionValuePriceFor(agentKind, model, pricing, row.day, priceOverrides),
                ledgerCurrency,
              )
            : null;
      if (estimate?.amount) {
        const estimates = subscriptionEstimatesByKey.get(key) ?? [];
        estimates.push(estimate);
        subscriptionEstimatesByKey.set(key, estimates);
      }
    }
  }
  for (const [key, m] of byKey) {
    if (m.money.amount === 0) {
      const estimates = subscriptionEstimatesByKey.get(key);
      if (estimates?.length) {
        m.estimatedMoney = addCompatibleRegionalMoney(estimates, ledgerCurrency);
      }
    }
  }
  const models = [...byKey.values()];

  // 每日 × 模型明细 (30 天窗口) — 堆叠柱状图分段。金额口径与 models 一致:
  // Claude 实报 $, Codex 行按价格表折算 (无价格 → 0, 该模型只出现在图例 token 行)。
  const modelDaily: UsageHistoryModelDay[] = modelRows.map((row) => {
    const agentKind = row.agentKind === 'codex'
      ? ('codex' as const)
      : row.agentKind === 'pi'
        ? ('pi' as const)
        : ('claude-code' as const);
    const model = displayModelName(row.model);
    const apiMoney = row.money.kind === 'actual-cost' ? row.money : zeroActual();
    const subscriptionEstimateMoney = isSubscriptionUsageModel(row.model)
      ? row.money.kind === 'value-estimate' && row.money.amount > 0
        ? row.money
        : row.money.kind !== 'value-estimate'
          ? (computePriceQuoteTurnMoney(
              row,
              getSubscriptionValuePriceFor(agentKind, model, pricing, row.day, priceOverrides),
              ledgerCurrency,
            ) ?? zeroEstimate())
          : zeroEstimate()
      : zeroEstimate();
    const money = apiMoney.amount > 0 ? apiMoney : subscriptionEstimateMoney;
    return {
      day: row.day,
      agentKind,
      model,
      money,
      apiMoney,
      subscriptionEstimateMoney,
      tokens: row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreateTokens: row.cacheCreateTokens,
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

  // 活跃日/异常阈值常量是 USD 口径;历史 CNY 行(或来源真声明 CNY 的账本)按
  // 固定汇率把阈值折到该行币种再比较。仅阈值启发式用,不产生任何展示金额。
  const heuristicThreshold = (base: number, currency: MoneyCurrency): number =>
    currency === 'CNY' ? base * USD_TO_CNY_FIXED_RATE : base;
  const activeDayMin = heuristicThreshold(ACTIVE_DAY_MIN_USD, ledgerCurrency);
  const anomalyMinToday = heuristicThreshold(
    ANOMALY_MIN_TODAY_USD,
    ledgerCurrency,
  );
  const activeDays = allDays
    .filter(
      (row) =>
        row.money.amount >=
        heuristicThreshold(ACTIVE_DAY_MIN_USD, row.money.currency),
    )
    .map((row) => row.day);
  const last30ActualByDay = new Map<string, RegionalMoney>();
  for (const row of allDays) {
    if (modelCutoff === null || row.day >= modelCutoff) {
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
      ? (addCompatibleRegionalMoney([last30, last30EstimatedValue], ledgerCurrency) ?? last30)
      : last30;
  // 与合计口径一致:估算若因币种不兼容被聚合弃掉,就不能再单独外露非零值,
  // 否则 UI 会声称「总额已含订阅估算」而实际未含。
  const exposedLast30EstimatedValue =
    last30EstimatedValue.currency === last30WithEstimatedValue.currency
      ? last30EstimatedValue
      : zeroEstimate();
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
    allDays.find((row) => row.day === todayKey && row.money.currency === ledgerCurrency)?.money ??
    zeroActual();

  return {
    generatedAt: Date.now(),
    todayKey,
    estimatesPending,
    days,
    modelDaily,
    models,
    ...(taskUsage ? { taskDaily: taskUsage.rows, tasks: taskUsage.tasks } : {}),
    streak: computeStreaks(activeDays, todayKey),
    totals: {
      today,
      last30Days: last30,
      last30DaysWithEstimatedValue: last30WithEstimatedValue,
      last30DaysEstimatedValue: exposedLast30EstimatedValue,
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
              currency: ledgerCurrency,
              approximate: trailing7Approximate,
              kind: 'actual-cost',
              ...(trailing7Approximate
                ? { estimateReasons: ['legacy-usd'] }
                : {}),
            },
    },
  };
}

/**
 * 其它电脑的行按它自己的本地日历记账,只精确到天,无法按小时换算到本机日历。
 * 合并口径:各设备按本地日期计;对方已跨入本机的「明天」时,超出本机今天的行归到本机
 * 今天 —— 否则那部分用量既不进今日合计,也不会出现在以本机今天为锚的图表里。
 */
export function clampPeerRowsToToday(rows: UsageDeviceRows, todayKey: string): UsageDeviceRows {
  const clamp = (day: string): string => (day > todayKey ? todayKey : day);
  return {
    spendDays: rows.spendDays.map((row) => ({ ...row, day: clamp(row.day) })),
    modelRows: rows.modelRows.map((row) => ({ ...row, day: clamp(row.day) })),
    sessionRows: rows.sessionRows.map((row) => ({ ...row, day: clamp(row.day) })),
    tasks: rows.tasks,
  };
}

/** 按设备范围替换原始行读取; 价格、账本币种等其余依赖不变。 */
export function usageHistoryDepsForScope(
  base: UsageHistoryDeps,
  scope: UsageHistoryDeviceScope,
  snapshot: Pick<PeerUsageSnapshot, 'peerRows'>,
): UsageHistoryDeps {
  if (scope === 'local') return base;
  let combined: Promise<UsageDeviceRows> | null = null;
  const rows = (): Promise<UsageDeviceRows> => {
    combined ??= (async () => {
      const todayKey = base.todayKey();
      const peer = (rows: UsageDeviceRows): UsageDeviceRows => clampPeerRowsToToday(rows, todayKey);
      if (scope !== 'all') {
        const one = snapshot.peerRows.get(scope);
        return one
          ? combineUsageDeviceRows([peer(one)])
          : { spendDays: [], modelRows: [], sessionRows: [], tasks: [] };
      }
      const [spendDays, modelRows] = await Promise.all([
        base.getAllSpendDays(),
        base.getModelUsageSince('0000-01-01'),
      ]);
      return combineUsageDeviceRows([
        { spendDays, modelRows, sessionRows: [], tasks: [] },
        ...[...snapshot.peerRows.values()].map(peer),
      ]);
    })();
    return combined;
  };
  return {
    ...base,
    getAllSpendDays: async () => (await rows()).spendDays,
    getModelUsageSince: async (sinceDayKey) =>
      (await rows()).modelRows.filter((row) => row.day >= sinceDayKey),
    // 任务按设备分开保留(同一任务 id 在两台电脑上互不合并),其它电脑的行同样按本机今天夹取。
    getTaskUsageSince: async (sinceDayKey) => {
      const todayKey = base.todayKey();
      const parts: Array<{ rows: UsageHistoryTaskDay[]; tasks: UsageHistoryTask[] }> = [];
      if (scope === 'all' && base.getTaskUsageSince) {
        parts.push(await base.getTaskUsageSince(sinceDayKey));
      }
      for (const [deviceId, peerRows] of snapshot.peerRows) {
        if (scope !== 'all' && scope !== deviceId) continue;
        const clamped = clampPeerRowsToToday(peerRows, todayKey);
        parts.push(
          tagTaskUsage(deviceId, {
            rows: clamped.sessionRows.filter((row) => row.day >= sinceDayKey),
            tasks: clamped.tasks,
          }),
        );
      }
      return {
        rows: parts.flatMap((part) => part.rows),
        tasks: parts.flatMap((part) => part.tasks),
      };
    },
  };
}

/** 本机设备条目兜底: 设备目录尚未读到 (未登录 / 未连接) 时选择器仍有「本机」。 */
function devicesWithSelf(snapshot: PeerUsageSnapshot): UsageDeviceSummary[] {
  if (snapshot.devices.some((device) => device.isSelf)) return snapshot.devices;
  return [
    {
      deviceId: snapshot.selfDeviceId ?? 'local',
      name: '',
      platform: null,
      isSelf: true,
      syncedAt: null,
      status: 'ok',
    },
    ...snapshot.devices,
  ];
}

async function readScopedUsageHistory(opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload> {
  const scope = normalizeDeviceScope(opts?.device);
  const peerSync = scope === 'local' ? null : getPeerUsageSync();
  if (!peerSync) {
    const payload = await readUsageHistoryWith(defaultDeps, opts);
    // 未注入跨设备同步 (单测 / 启动窗口) 时多设备范围退化为本机, 选择器只剩本机。
    return scope === 'local'
      ? payload
      : { ...payload, devices: devicesWithSelf({ version: 0, selfDeviceId: null, devices: [], peerRows: new Map() }) };
  }
  const snapshot = await peerSync.snapshot();
  const payload = await readUsageHistoryWith(usageHistoryDepsForScope(defaultDeps, scope, snapshot), opts);
  return {
    ...payload,
    devices: devicesWithSelf(snapshot),
    devicesSyncing: peerSync.isSyncing(),
    peerVersion: snapshot.version,
  };
}

/**
 * 生产入口 (usage.ts adapter 注入给 IPC handler)。
 * 设备目录 / 状态 / 同步时间是展示元数据:在唯一出口按当前快照附上,不参与聚合与缓存
 * 失效判断 —— 聚合只随用量行变化(见 peerUsageSync 的聚合版本)。
 */
export async function readUsageHistory(opts?: UsageHistoryReadOptions): Promise<UsageHistoryPayload> {
  const payload = await withCurrentLocalTasks(await readAggregatedUsageHistory(opts));
  const peerSync = normalizeDeviceScope(opts?.device) === 'local' ? null : getPeerUsageSync();
  if (!peerSync) return payload;
  return {
    ...payload,
    devices: devicesWithSelf(await peerSync.snapshot()),
    devicesSyncing: peerSync.isSyncing(),
  };
}

/**
 * 本机任务的标题 / 模型 / 删除状态同属展示元数据:在唯一出口按当前库覆盖,聚合缓存
 * 只提供用量行。重命名、删除不产生用量,不能等下一次重聚合才生效。
 */
async function withCurrentLocalTasks(payload: UsageHistoryPayload): Promise<UsageHistoryPayload> {
  if (!payload.tasks?.some((task) => task.deviceId === LOCAL_TASK_DEVICE)) return payload;
  let current: Map<string, Awaited<ReturnType<typeof getUsageTaskMeta>>[number]>;
  try {
    current = new Map((await getUsageTaskMeta()).map((task) => [task.sessionId, task]));
  } catch (err) {
    log.debug('read usage task meta failed:', err instanceof Error ? err.message : String(err));
    return payload;
  }
  return {
    ...payload,
    tasks: payload.tasks.flatMap((task) => {
      if (task.deviceId !== LOCAL_TASK_DEVICE) return [task];
      const meta = current.get(task.sessionId);
      return meta ? [{ ...task, ...meta }] : [];
    }),
  };
}

async function readAggregatedUsageHistory(
  opts?: UsageHistoryReadOptions,
): Promise<UsageHistoryPayload> {
  const key = optsKey(opts);
  const peerSync = normalizeDeviceScope(opts?.device) === 'local' ? null : getPeerUsageSync();
  // 节流的跨设备同步; 同步期间返回 stale, renderer 短轮询直到拿到合并后的结果。
  if (peerSync) void peerSync.sync();
  // 唯一的跨设备新鲜度判据:同步已结束,且聚合所用的设备数据版本就是当前版本。
  // 同步在聚合过程中结束时版本已前进,这份结果不能标成最新。
  const peerFresh = (payload: UsageHistoryPayload): boolean =>
    !peerSync || (!peerSync.isSyncing() && payload.peerVersion === peerSync.version());
  const settle = (payload: UsageHistoryPayload): UsageHistoryPayload => {
    if (peerFresh(payload)) {
      return freshPayload({ ...payload, ...(peerSync ? { devicesSyncing: false } : {}) });
    }
    // 版本已前进:后台按新数据重聚合,renderer 的 stale 短轮询随后拿到它。
    if (peerSync && payload.peerVersion !== peerSync.version()) {
      refreshUsageHistoryInBackground(key, opts);
    }
    return stalePayload({ ...payload, devicesSyncing: peerSync?.isSyncing() ?? false });
  };
  if (opts?.forceRefresh) {
    const fresh = await refreshUsageHistory(key, opts);
    if (fresh) return settle(fresh);
    if (cachedHistory && cachedHistoryOptsKey === key) return stalePayload(cachedHistory);
    const diskPayload = await hydrateFromDisk(key);
    if (diskPayload) return stalePayload(diskPayload);
    return emptyUsageHistoryPayload();
  }
  if (cachedHistory && cachedHistoryOptsKey === key) {
    if (refreshInFlightByOptsKey.has(key)) return stalePayload(cachedHistory);
    // 多设备范围只在输入变化时重聚合:本机用量 / 价格变化走 forceRefresh 推送,设备数据
    // 变化体现为版本前进,跨天由 todayKey 判定。其余定时重读直接复用,不重扫全量历史;
    // 同步进行中是否标为更新中由 settle(peerFresh)决定,与是否重聚合分开。
    const reusable =
      isMemoryFresh(cachedHistory) ||
      (peerSync !== null &&
        cachedHistory.peerVersion === peerSync.version() &&
        cachedHistory.todayKey === localDayKey());
    if (reusable) return settle(cachedHistory);
    refreshUsageHistoryInBackground(key, opts);
    return stalePayload(cachedHistory);
  }
  const diskPayload = await hydrateFromDisk(key);
  if (diskPayload) {
    refreshUsageHistoryInBackground(key, opts);
    return stalePayload(diskPayload);
  }
  const fresh = await refreshUsageHistory(key, opts);
  return fresh ? settle(fresh) : emptyUsageHistoryPayload();
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
      today: zeroUsageMoney(),
      last30Days: zeroUsageMoney(),
      last30DaysWithEstimatedValue: zeroUsageMoney(),
      last30DaysEstimatedValue: zeroUsageMoney('value-estimate'),
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
