/**
 * usageHistoryStats — 用量历史页的纯聚合函数 (无 DOM / 无 IPC 依赖, 便于单测)。
 *
 * 口径约定 (与 issue #2785 的裁决一致): 本页只统计 token, 不出现任何金额、账户额度或预算。
 * 因此这里的「活跃日」按**当日有 token 记录**判定, 而不是 payload 自带的 `streak`
 * —— 那个字段用 `ACTIVE_DAY_MIN_USD` 打在 `daily_spend` 上, 订阅用户恒为 0。
 *
 * 两个窗口不同, 调用方不要混用:
 *   - `days[]` 覆盖 140 天 (main 侧 usageRowsSince 已按热力图窗口取行) → 热力图、连续活跃天数
 *   - `models[]` / `modelDaily` 是 30 天 → 按模型、按 agent、每日柱图
 */

import type { UsageHistoryModel, UsageHistoryPayload } from '@/hooks/useUsageHistory';

export type UsageAgentKind = UsageHistoryModel['agentKind'];

export interface UsageDay {
  day: string;
  tokens: number;
}

export type UsageHistoryRange = 'all' | '30d' | '7d' | 'today' | `day:${string}`;

export interface ModelTokenRow {
  key: string;
  agentKind: UsageAgentKind;
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 占近 30 天总量的比例 (0..1); 总量为 0 时为 0。 */
  share: number;
  /** cacheRead / (input + cacheRead + cacheCreate); 分母为 0 时为 null。 */
  cacheHitRate: number | null;
}

export interface AgentTokenRow {
  agentKind: UsageAgentKind;
  tokens: number;
  todayTokens: number;
  share: number;
  cacheHitRate: number | null;
  modelCount: number;
}

/**
 * 缓存命中率 —— 与 `shared/turnUsageDetails.ts` 的 `buildTurnUsageDetails` 同一公式,
 * 只是把窗口从一轮扩到统计区间。聚合时必须分子分母各自加总后再除,
 * 不能对各模型的命中率取平均 (那会让小用量模型获得与大用量模型相同的权重)。
 */
export function cacheHitRate(input: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}): number | null {
  const denominator = input.inputTokens + input.cacheReadTokens + input.cacheCreateTokens;
  if (denominator <= 0) return null;
  return input.cacheReadTokens / denominator;
}

export function modelTokenTotal(model: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}): number {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreateTokens;
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + deltaDays);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function usageRangeDay(range: UsageHistoryRange, todayKey?: string): string | null {
  if (range === 'today') return todayKey ?? null;
  return range.startsWith('day:') ? range.slice(4) : null;
}

/** Exact-day ranges cannot provide a distinct "today" comparison column. */
export function isUsageHistorySingleDay(range: UsageHistoryRange): boolean {
  return range === 'today' || usageRangeDay(range) !== null;
}

export function isUsageDayInRange(
  day: string,
  todayKey: string,
  range: UsageHistoryRange,
): boolean {
  const selectedDay = usageRangeDay(range);
  if (selectedDay) return day === selectedDay;
  if (range === 'all') return true;
  if (range === 'today') return day === todayKey;
  const days = range === '7d' ? 7 : 30;
  return day >= shiftDayKey(todayKey, -(days - 1)) && day <= todayKey;
}

/**
 * Derive the table/statistics payload for a selected range. Charts intentionally
 * receive their own fixed-window slices so changing this range never changes
 * the heatmap or daily-token chart.
 */
export function filterUsageHistoryPayload(
  payload: UsageHistoryPayload | null,
  range: UsageHistoryRange,
): UsageHistoryPayload | null {
  if (!payload) return null;

  const selectedDay = usageRangeDay(range, payload.todayKey);
  const rangeTodayKey = selectedDay ?? payload.todayKey;
  const modelByKey = new Map<string, UsageHistoryModel>();
  for (const row of payload.modelDaily) {
    if (!isUsageDayInRange(row.day, payload.todayKey, range) || row.tokens <= 0) continue;
    const key = `${row.agentKind}\u0000${row.model}`;
    const existing = modelByKey.get(key);
    const componentTotal =
      (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cacheReadTokens ?? 0) +
      (row.cacheCreateTokens ?? 0);
    // Old renderer snapshots only carried `tokens`; preserve their totals until
    // the next main-process refresh supplies the component fields.
    const inputTokens = row.inputTokens ?? (componentTotal === 0 ? row.tokens : 0);
    const outputTokens = row.outputTokens ?? 0;
    const cacheReadTokens = row.cacheReadTokens ?? 0;
    const cacheCreateTokens = row.cacheCreateTokens ?? 0;
    if (existing) {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheReadTokens += cacheReadTokens;
      existing.cacheCreateTokens += cacheCreateTokens;
      continue;
    }
    modelByKey.set(key, {
      agentKind: row.agentKind,
      model: row.model,
      money: row.money,
      estimatedMoney:
        row.subscriptionEstimateMoney.amount > 0 ? row.subscriptionEstimateMoney : null,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
    });
  }

  const modelDaily = payload.modelDaily.filter((row) =>
    isUsageDayInRange(row.day, payload.todayKey, range),
  );
  const days = payload.days.filter((row) => isUsageDayInRange(row.day, payload.todayKey, range));
  const models = [...modelByKey.values()];
  const lastRangeTokens = models.reduce((sum, model) => sum + modelTokenTotal(model), 0);
  const todayTokens = modelDaily
    .filter((row) => row.day === rangeTodayKey)
    .reduce((sum, row) => sum + row.tokens, 0);

  return {
    ...payload,
    todayKey: rangeTodayKey,
    days,
    modelDaily,
    models,
    totals: {
      ...payload.totals,
      todayTokens,
      last30DaysTokens: lastRangeTokens,
    },
    streak: computeTokenStreak(
      days
        .map((row) => ({ day: row.day, tokens: row.tokens ?? 0 }))
        .filter((row) => row.tokens > 0),
      rangeTodayKey,
    ),
  };
}

export function chartUsageHistoryPayload(
  payload: UsageHistoryPayload | null,
): UsageHistoryPayload | null {
  if (!payload) return null;
  const charts = filterUsageHistoryPayload(payload, '30d');
  return {
    ...(charts ?? payload),
    // The heatmap decides its own visible window from the measured card width.
    // Keep the full `days` history here so a wide settings card can expose more
    // than the old fixed 20-week slice; the daily bar chart still uses modelDaily
    // from the fixed 30-day chart payload above.
    days: payload.days,
  };
}

/** payload.days → 只保留 token 维度 (热力图与 streak 的共同输入)。 */
export function toUsageDays(payload: UsageHistoryPayload | null): UsageDay[] {
  if (!payload) return [];
  return payload.days
    .map((row) => ({ day: row.day, tokens: row.tokens ?? 0 }))
    .filter((row) => row.tokens > 0)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * token 口径的连续活跃天数。
 *
 * 今日还没有记录时从昨天起算 (当天刚开机不该把昨天的连续记录清零, 与 main 侧
 * `computeStreaks` 同一处理)。`longest` 只在传入窗口内计算 —— days 覆盖 140 天,
 * 因此首版最长连续以 140 天为上限。
 */
export function computeTokenStreak(
  days: UsageDay[],
  todayKey: string,
): { current: number; longest: number } {
  const active = new Set(days.filter((d) => d.tokens > 0).map((d) => d.day));
  if (active.size === 0 || !todayKey) return { current: 0, longest: 0 };

  let current = 0;
  let cursor = active.has(todayKey) ? todayKey : shiftDayKey(todayKey, -1);
  while (active.has(cursor)) {
    current += 1;
    cursor = shiftDayKey(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of [...active].sort()) {
    run = previous !== null && shiftDayKey(previous, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }

  return { current, longest };
}

/**
 * 近 30 天按模型, 按 token 降序。
 *
 * **必须按 (agentKind, 展示模型名) 再合并一次**: main 侧按原始 model 聚合, 而同一个模型的
 * API 与订阅两个计费维度带着 `#billing=api` / `#billing=subscription` 后缀分行
 * (`main/usage/usageHistory.ts` 的 byKey), 暴露到 payload 时后缀已被 displayModelName 剥掉。
 * 直接用展示名建 key 会渲染出两行看不出区别的同名模型、产生重复 React key,
 * 并让「用到的模型」数与 Agent 表的模型数多算。本页只统计 token, 不区分计费维度, 合并即可。
 */
export function buildModelRows(payload: UsageHistoryPayload | null): ModelTokenRow[] {
  if (!payload) return [];
  const merged = new Map<string, ModelTokenRow>();
  for (const model of payload.models) {
    const tokens = modelTokenTotal(model);
    if (tokens <= 0) continue;
    const key = `${model.agentKind} ${model.model}`;
    const existing = merged.get(key);
    if (existing) {
      existing.tokens += tokens;
      existing.inputTokens += model.inputTokens;
      existing.outputTokens += model.outputTokens;
      existing.cacheReadTokens += model.cacheReadTokens;
      existing.cacheCreateTokens += model.cacheCreateTokens;
      continue;
    }
    merged.set(key, {
      key,
      agentKind: model.agentKind,
      model: model.model,
      tokens,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheReadTokens: model.cacheReadTokens,
      cacheCreateTokens: model.cacheCreateTokens,
      share: 0,
      cacheHitRate: null,
    });
  }
  const rows = [...merged.values()].sort((a, b) => b.tokens - a.tokens);

  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row) => ({
    ...row,
    share: total > 0 ? row.tokens / total : 0,
    cacheHitRate: cacheHitRate(row),
  }));
}

/** 近 30 天按 agent / harness。today 取自 modelDaily 的今日行, 缺失时为 0。 */
export function buildAgentRows(payload: UsageHistoryPayload | null): AgentTokenRow[] {
  if (!payload) return [];

  const todayByAgent = new Map<UsageAgentKind, number>();
  for (const row of payload.modelDaily) {
    if (row.day !== payload.todayKey || row.tokens <= 0) continue;
    todayByAgent.set(row.agentKind, (todayByAgent.get(row.agentKind) ?? 0) + row.tokens);
  }

  interface AgentAcc extends AgentTokenRow {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  }
  const byAgent = new Map<UsageAgentKind, AgentAcc>();
  // 走合并后的模型行 —— 同一模型的 api / subscription 两个计费维度已并成一行,
  // 否则 modelCount 会把同一个模型数成两个 (见 buildModelRows 的注释)。
  for (const model of buildModelRows(payload)) {
    const tokens = model.tokens;
    if (tokens <= 0) continue;
    const acc = byAgent.get(model.agentKind) ?? {
      agentKind: model.agentKind,
      tokens: 0,
      todayTokens: todayByAgent.get(model.agentKind) ?? 0,
      share: 0,
      cacheHitRate: null,
      modelCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    acc.tokens += tokens;
    acc.modelCount += 1;
    acc.inputTokens += model.inputTokens;
    acc.cacheReadTokens += model.cacheReadTokens;
    acc.cacheCreateTokens += model.cacheCreateTokens;
    byAgent.set(model.agentKind, acc);
  }

  const rows = [...byAgent.values()].sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row) => ({
    agentKind: row.agentKind,
    tokens: row.tokens,
    todayTokens: row.todayTokens,
    share: total > 0 ? row.tokens / total : 0,
    cacheHitRate: cacheHitRate(row),
    modelCount: row.modelCount,
  }));
}

export interface UsageSummary {
  todayTokens: number;
  last30DaysTokens: number;
  streak: { current: number; longest: number };
  cacheHitRate: number | null;
  modelCount: number;
}

/** 页面顶部统计条。token 总量直接用 payload.totals, 不自己二次求和。 */
export function buildSummary(payload: UsageHistoryPayload | null): UsageSummary {
  const models = buildModelRows(payload);
  return {
    todayTokens: payload?.totals.todayTokens ?? 0,
    last30DaysTokens: payload?.totals.last30DaysTokens ?? 0,
    streak: computeTokenStreak(toUsageDays(payload), payload?.todayKey ?? ''),
    cacheHitRate: cacheHitRate({
      inputTokens: models.reduce((sum, m) => sum + m.inputTokens, 0),
      cacheReadTokens: models.reduce((sum, m) => sum + m.cacheReadTokens, 0),
      cacheCreateTokens: models.reduce((sum, m) => sum + m.cacheCreateTokens, 0),
    }),
    modelCount: models.length,
  };
}

/** 页面是否完全没有数据可展示 (决定渲染空态还是正文)。 */
export function isUsageHistoryEmpty(payload: UsageHistoryPayload | null): boolean {
  if (!payload) return true;
  return (
    (payload.totals.last30DaysTokens ?? 0) <= 0 &&
    toUsageDays(payload).length === 0 &&
    buildModelRows(payload).length === 0
  );
}
