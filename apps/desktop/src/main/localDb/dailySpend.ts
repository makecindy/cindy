import { sql } from 'drizzle-orm';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  addRegionalMoney,
  normalizeRegionalMoney,
  regionalCurrencyForRegion,
  regionalizeLegacyUsd,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailySpend } from './schema.js';
import { getDbClient } from './client/current.js';

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
  const legacy = regionalizeLegacyUsd(row?.costUsd ?? 0, CURRENT_CINDY_REGION);
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
  const expectedCurrency = regionalCurrencyForRegion(CURRENT_CINDY_REGION);
  if (normalized.currency !== expectedCurrency) {
    throw new Error(
      `daily spend currency mismatch: ${normalized.currency} != ${expectedCurrency}`,
    );
  }

  const db = getDbClient().drizzle;
  const existing = await db
    .select({ costCurrency: dailySpend.costCurrency })
    .from(dailySpend)
    .where(sql`${dailySpend.day} = ${day}`)
    .get();
  if (existing?.costCurrency && existing.costCurrency !== normalized.currency) {
    throw new Error('daily spend row has conflicting currency');
  }
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
        costAmount: sql`${dailySpend.costAmount} + ${normalized.amount}`,
        costCurrency: normalized.currency,
        costIsApproximate: sql`${dailySpend.costIsApproximate} OR ${normalized.approximate ? 1 : 0}`,
        updatedAt: ts,
      },
    })
    .run();
  return { day, money: await getSpendForDay(day) };
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
