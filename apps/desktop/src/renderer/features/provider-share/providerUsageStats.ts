/**
 * 「远程与分享」页「用量」块的纯函数(供应商组 §7)：把按天明细摊成一张表，再按时间段、使用方与组内电脑
 * 筛选、汇总。与设置 → 用量同一种做法：数据一次读来，筛选都在界面上做。不读 window、不碰 i18n，便于单测。
 */
import { isUsageDayInRange, type UsageHistoryRange } from '@/components/settings/usage/usageHistoryStats';
import { usageModelKey } from '@/components/new-chat/usagePalette';

import type {
  ProviderOwnUsageView,
  ProviderShareMemberView,
  ProviderShareModelUsageView,
  ProviderShareMoney,
  ProviderUsageHistoryView,
} from '../../../shared/providerShare';

/** 使用方的键：你自己、分享的人(按成员)、经另一台电脑转来的(按那台电脑)。 */
export const SELF_PARTY = 'self';
export const memberParty = (memberId: string) => `member:${memberId}`;
export const relayParty = (deviceId: string) => `relay:${deviceId}`;

export interface ProviderUsageRow extends ProviderShareModelUsageView {
  party: string;
  /** 那台电脑的本地日期；null = 旧版电脑只给了所有时间的合计。 */
  day: string | null;
  /** 组内电脑(同一台电脑上的多个账号已合成一台)；null = 当时没有区分电脑。 */
  computer: string | null;
}

export interface ProviderUsageFilter {
  range: UsageHistoryRange;
  todayKey: string;
  /** 'all' 或使用方的键。 */
  party: string;
  /** 'all' 或组内电脑的键。 */
  computer: string;
}

export interface ProviderUsageTotals {
  /** 输入 + 输出 token，与分享用量同口径。 */
  tokens: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 估算金额；没有可估算的行、或币种不一致时为 null(不换算、不伪造合计)。 */
  amount: ProviderShareMoney | null;
  /** 缓存读取 ÷(输入 + 缓存读取 + 缓存写入)，与设置 → 用量同口径；没有输入时为 null。 */
  cacheHitRate: number | null;
}

function computerOf(memberKey: string | null, aliases?: ReadonlyMap<string, string>): string | null {
  return memberKey === null ? null : aliases?.get(memberKey) ?? memberKey;
}

/** 按天明细摊成一张表(你自己、分享的人、转来的)。 */
export function rowsFromHistory(
  history: ProviderUsageHistoryView,
  aliases?: ReadonlyMap<string, string>,
): ProviderUsageRow[] {
  const rows: ProviderUsageRow[] = [];
  const push = (party: string, days: ProviderUsageHistoryView['self']['days']) => {
    for (const day of days) rows.push({ ...day, party, computer: computerOf(day.memberKey, aliases) });
  };
  push(SELF_PARTY, history.self.days);
  for (const member of history.members) push(memberParty(member.memberId), member.days);
  for (const relay of history.relays) push(relayParty(relay.deviceId), relay.days);
  return rows;
}

/**
 * 旧版电脑(不认识按天明细)：只有所有时间的合计——你自己读 own-usage，分享的人读 owned 里的成员用量，
 * 都按 range=all 读来。没有日期，界面只能看「所有时间」。
 */
export function rowsFromLegacy(
  own: ProviderOwnUsageView | null,
  members: readonly ProviderShareMemberView[],
  aliases?: ReadonlyMap<string, string>,
): ProviderUsageRow[] {
  const rows: ProviderUsageRow[] = [];
  const push = (party: string, models: readonly ProviderShareModelUsageView[]) => {
    for (const model of models) rows.push({ ...model, party, day: null, computer: computerOf(model.memberKey, aliases) });
  };
  for (const part of [own?.local, ...(own?.devices ?? [])]) if (part) push(SELF_PARTY, part.models);
  for (const member of members) push(memberParty(member.memberId), member.models);
  for (const relay of own?.relays ?? []) if (relay.deviceId) push(relayParty(relay.deviceId), relay.models);
  return rows;
}

export function inRange(row: ProviderUsageRow, filter: Pick<ProviderUsageFilter, 'range' | 'todayKey'>): boolean {
  return row.day === null ? filter.range === 'all' : isUsageDayInRange(row.day, filter.todayKey, filter.range);
}

/**
 * 按条件筛选。每张表都按「其他维度」筛：按人表不按使用方筛(分享的管理操作一直在)，按电脑表不按电脑筛，
 * 图表不按时间段筛(固定窗口)，由 skip 指明不筛的维度。
 */
export function filterUsageRows(
  rows: readonly ProviderUsageRow[],
  filter: ProviderUsageFilter,
  skip: { party?: boolean; computer?: boolean; range?: boolean } = {},
): ProviderUsageRow[] {
  return rows.filter((row) =>
    (skip.party || filter.party === 'all' || row.party === filter.party)
    && (skip.computer || filter.computer === 'all' || row.computer === filter.computer)
    && (skip.range || inRange(row, filter)));
}

export function summarizeUsageRows(rows: readonly ProviderUsageRow[]): ProviderUsageTotals {
  const totals: ProviderUsageTotals = {
    tokens: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    amount: null,
    cacheHitRate: null,
  };
  let mixedCurrency = false;
  for (const row of rows) {
    totals.inputTokens += Math.max(0, row.inputTokens);
    totals.outputTokens += Math.max(0, row.outputTokens);
    totals.cacheReadTokens += Math.max(0, row.cacheReadTokens);
    totals.cacheCreateTokens += Math.max(0, row.cacheCreateTokens);
    totals.turns += Math.max(0, row.turns);
    if (!row.amount) continue;
    if (!totals.amount) totals.amount = { ...row.amount };
    else if (totals.amount.currency === row.amount.currency) totals.amount.amount += row.amount.amount;
    else mixedCurrency = true;
  }
  totals.tokens = totals.inputTokens + totals.outputTokens;
  if (mixedCurrency) totals.amount = null;
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreateTokens;
  totals.cacheHitRate = prompt > 0 ? totals.cacheReadTokens / prompt : null;
  return totals;
}

export function groupUsageRows<K>(rows: readonly ProviderUsageRow[], keyOf: (row: ProviderUsageRow) => K): Map<K, ProviderUsageRow[]> {
  const groups = new Map<K, ProviderUsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** 模型的键：Agent × 完整模型名(与设置 → 用量的配色身份相同)。 */
export const modelKeyOf = (row: Pick<ProviderUsageRow, 'kind' | 'model'>) => usageModelKey(row.kind, row.model);

/** 按 token 从多到少排的键：配色按完整历史排一次，筛选与时间段变化不重新分配颜色。 */
export function keysByTokens(rows: readonly ProviderUsageRow[], keyOf: (row: ProviderUsageRow) => string): string[] {
  const tokens = new Map<string, number>();
  for (const row of rows) tokens.set(keyOf(row), (tokens.get(keyOf(row)) ?? 0) + row.inputTokens + row.outputTokens);
  return [...tokens.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}

/**
 * 组内电脑的顺序：组里每台按组里的顺序(这段时间没用过的也列)，之后是已经移出组、用过的电脑(用量多的在前)，
 * 最后是当时没有区分电脑的更早记录(null)。
 */
export function computerOrder(
  memberKeys: readonly string[],
  rows: readonly ProviderUsageRow[],
): Array<string | null> {
  const known = new Set(memberKeys);
  const removed = keysByTokens(rows.filter((row) => row.computer !== null && !known.has(row.computer)), (row) => row.computer!);
  const hasUnattributed = rows.some((row) => row.computer === null);
  return [...memberKeys, ...removed, ...(hasUnattributed ? [null] : [])];
}

/** 热力图：每天的 token 合计。 */
export function usageRowsByDay(rows: readonly ProviderUsageRow[]): Array<{ day: string; tokens: number }> {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.day === null) continue;
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.inputTokens + row.outputTokens);
  }
  return [...byDay.entries()].map(([day, tokens]) => ({ day, tokens }));
}
