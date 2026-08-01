import { sql } from 'drizzle-orm';

import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailySpend } from './schema.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';

const log = createLogger('localDb/dailySpend');

export function localDayKey(ts: number = Date.now()): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rowMoney(
  row:
    | {
        costUsd: number;
        costAmount: number;
        costCurrency: 'CNY' | 'USD' | null;
        costIsApproximate: boolean;
      }
    | undefined,
): RegionalMoney {
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

async function getSpendForDay(day: string): Promise<RegionalMoney> {
  const row = await getDbClient()
    .drizzle.select({
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
  // 单币种日账本:入口只接受本账号的结算币种。基准取 currentLedgerCurrency() 而不是
  // 构建区域 —— 结算币种由服务端按账号所属租户下发,不保证等于发行区域;按区域判会把
  // 以 USD 结算的账号在 CN 构建上的每一笔都拒收成不计费。
  // 异币种(脏数据 / 上游 bug)仍然拒收,避免污染已有账本。
  const ledgerCurrency = currentLedgerCurrency();
  if (normalized.currency !== ledgerCurrency) {
    log.warn(
      `daily spend rejected currency mismatch: ${normalized.currency} != ${ledgerCurrency}`,
    );
    return { day, money: await getSpendForDay(day) };
  }
  const db = getDbClient().drizzle;
  // 升级前 / 换号前当天若仍是旧币种，首笔新费用从当前账本币种重新起算；不猜测或换算
  // 旧聚合值，也不让当天后续费用永久停记。CASE 与写入保持原子，避免并发混加不同单位。
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
        costAmount: sql`CASE WHEN ${sameCurrency} THEN ${dailySpend.costAmount} + ${normalized.amount} ELSE ${normalized.amount} END`,
        costCurrency: normalized.currency,
        costIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${dailySpend.costIsApproximate} OR ${normalized.approximate ? 1 : 0}) ELSE ${normalized.approximate ? 1 : 0} END`,
        updatedAt: ts,
      },
    })
    .run();
  const persisted = await getSpendForDay(day);
  return { day, money: persisted };
}

export function getTodaySpend(): Promise<RegionalMoney> {
  return getSpendForDay(localDayKey());
}

export async function getAllSpendDays(): Promise<Array<{ day: string; money: RegionalMoney }>> {
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
  return rows.map((row) => ({ day: row.day, money: rowMoney(row) }));
}
