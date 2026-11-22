import { sql } from 'drizzle-orm';

import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type MoneyCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailySpend } from './schema.js';
import { getDbClient } from './client/current.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';


export function localDayKey(ts: number = Date.now()): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface SpendRow {
  costUsd: number;
  costAmount: number;
  costCurrency: 'CNY' | 'USD' | null;
  costIsApproximate: boolean;
}

function rowMoney(row: SpendRow | undefined): RegionalMoney {
  const legacy = legacyUsdMoney(row?.costUsd ?? 0);
  const current =
    row?.costCurrency && row.costAmount > 0
      ? normalizeRegionalMoney({
          amount: row.costAmount,
          currency: row.costCurrency,
          approximate: row.costIsApproximate,
          kind: 'actual-cost',
        })
      : undefined;
  if (legacy.amount > 0 && current) {
    return legacy.currency === current.currency ? addRegionalMoney([legacy, current]) : current;
  }
  return current ?? (legacy.amount > 0 ? legacy : zeroUsageMoney());
}

/** 一天里各币种各自的金额（每币种一行，故至多一种币出现一次）。 */
function dayMonies(rows: readonly SpendRow[]): RegionalMoney[] {
  return rows.map(rowMoney).filter((money) => money.amount > 0);
}

/**
 * 把一天的多币种金额折叠成展示用的单值。
 *
 * 一天可能有多个币种行(换号 / 跨租户 / 上游漏发币种)。展示侧仍是单币种，按账本币种
 * 挑那一行；账本币种缺席时 addCompatibleRegionalMoney 会挑真实计费里的第一种。
 *
 * **币种参数必须由调用方显式传入**：折叠是一个依赖账本币种的决定，而账本币种在冷启动
 * 期间要等报价快照恢复才确定。此前这里直接读 currentLedgerCurrency()，于是
 * getAllSpendDays() 与 getGatewayModelPricing() 并发时会先按兜底币种把 CNY 行全丢掉，
 * 调用方拿到的已经是折叠过的错值，首页整段历史短暂显示为 0。
 */
export function collapseDayMonies(
  monies: readonly RegionalMoney[],
  ledgerCurrency: MoneyCurrency,
): RegionalMoney {
  const zero = (): RegionalMoney => ({
    amount: 0,
    currency: ledgerCurrency,
    approximate: false,
    kind: 'actual-cost',
  });
  if (monies.length === 0) return zero();
  return addCompatibleRegionalMoney(monies, ledgerCurrency) ?? zero();
}

async function getSpendMoniesForDay(day: string): Promise<RegionalMoney[]> {
  const rows = await getDbClient()
    .drizzle.select({
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .where(sql`${dailySpend.day} = ${day}`)
    .all();
  return dayMonies(rows);
}

/**
 * 今日展示与写入回执共用：调用方须保证账本币种已就绪。
 * 保留选中币种的原始金额。
 */
async function getSpendForDay(day: string): Promise<RegionalMoney> {
  const monies = await getSpendMoniesForDay(day);
  const ledgerCurrency = currentLedgerCurrency();
  return collapseDayMonies(monies, ledgerCurrency);
}

export async function incrementDailySpend(
  money: RegionalMoney,
  ts: number = Date.now(),
): Promise<{ day: string; money: RegionalMoney }> {
  const day = localDayKey(ts);
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) {
    return { day, money: await getSpendForDay(day) };
  }
  // A provider can charge either currency on the same day.
  const db = getDbClient().drizzle;
  await db
    .insert(dailySpend)
    .values({
      day,
      costAmount: normalized.amount,
      costCurrency: normalized.currency,
      costIsApproximate: normalized.approximate,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [dailySpend.day, dailySpend.costCurrency],
      set: {
        costAmount: sql`${dailySpend.costAmount} + ${normalized.amount}`,
        costIsApproximate: sql`(${dailySpend.costIsApproximate} OR ${normalized.approximate ? 1 : 0})`,
        updatedAt: ts,
      },
    })
    .run();
  const persisted = await getSpendForDay(day);
  return { day, money: persisted };
}

/**
 * 今日金额。调用方须保证账本币种已就绪（见 usageBroadcaster.readTodaySpend），
 * 否则冷启动首帧会按兜底币种折叠掉其它币种行。
 */
export function getTodaySpend(): Promise<RegionalMoney> {
  return getSpendForDay(localDayKey());
}

/**
 * 每日金额，**按币种拆开不折叠**。
 *
 * 与 getModelUsageSince 同口径：读侧只负责把事实取出来，「按哪个币种展示」交给调用方在
 * 账本币种确定之后决定。折叠用 collapseDayMonies。
 */
export async function getAllSpendDays(): Promise<
  Array<{ day: string; monies: RegionalMoney[] }>
> {
  const rows = await getDbClient()
    .drizzle.select({
      day: dailySpend.day,
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .orderBy(dailySpend.day)
    .all();
  const byDay = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.push(row);
    else byDay.set(row.day, [row]);
  }
  return [...byDay.entries()].map(([day, dayRows]) => ({ day, monies: dayMonies(dayRows) }));
}
