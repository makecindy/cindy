import { sql } from 'drizzle-orm';

import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailySpend } from './schema.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('localDb/dailySpend');

export function localDayKey(ts: number = Date.now()): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rowMoney(row: {
  costUsd: number;
  costAmount: number;
  costCurrency: 'CNY' | 'USD' | null;
  costIsApproximate: boolean;
} | undefined): RegionalMoney {
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
    return legacy.currency === current.currency
      ? addRegionalMoney([legacy, current])
      : current;
  }
  return current ?? legacy;
}

async function getSpendForDay(day: string): Promise<RegionalMoney> {
  const row = await getDbClient().drizzle
    .select({
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .where(sql`${dailySpend.day} = ${day}`)
    .get();
  return rowMoney(row);
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
  const db = getDbClient().drizzle;
  // 单币种日账本:币种守卫必须在同一条 upsert 里用 CASE 表达 —— 先查再写有
  // TOCTOU 窗口,并发首写会把不同币种的裸数字加进同一行。冲突段原子地弃掉
  // (行保持原币种),绝不 throw:抛异常会打断 turn 收尾管道,损失更大。
  const sameCurrency = sql`(${dailySpend.costCurrency} IS NULL OR ${dailySpend.costCurrency} = ${normalized.currency})`;
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
      target: dailySpend.day,
      set: {
        costAmount: sql`CASE WHEN ${sameCurrency} THEN ${dailySpend.costAmount} + ${normalized.amount} ELSE ${dailySpend.costAmount} END`,
        costCurrency: sql`CASE WHEN ${sameCurrency} THEN ${normalized.currency} ELSE ${dailySpend.costCurrency} END`,
        costIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${dailySpend.costIsApproximate} OR ${normalized.approximate ? 1 : 0}) ELSE ${dailySpend.costIsApproximate} END`,
        updatedAt: ts,
      },
    })
    .run();
  const persisted = await getSpendForDay(day);
  if (persisted.currency !== normalized.currency && persisted.amount > 0) {
    log.warn(
      `daily spend currency conflict on ${day}: keeping ${persisted.currency}, dropped ${normalized.currency} amount`,
    );
  }
  return { day, money: persisted };
}

export function getTodaySpend(): Promise<RegionalMoney> {
  return getSpendForDay(localDayKey());
}

export async function getAllSpendDays(): Promise<
  Array<{ day: string; money: RegionalMoney }>
> {
  const rows = await getDbClient().drizzle
    .select({
      day: dailySpend.day,
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .orderBy(dailySpend.day)
    .all();
  return rows.map((row) => ({ day: row.day, money: rowMoney(row) }));
}
