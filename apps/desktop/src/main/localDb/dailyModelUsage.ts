import { sql } from 'drizzle-orm';

import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailyModelUsage } from './schema.js';
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';

const log = createLogger('localDb/dailyModelUsage');

export interface DailyModelUsageDelta {
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  money?: RegionalMoney | null;
  inputTokensDelta: number;
  outputTokensDelta: number;
  cacheReadTokensDelta: number;
  cacheCreateTokensDelta: number;
}

export interface DailyModelUsageRow {
  day: string;
  agentKind: string;
  model: string;
  money: RegionalMoney;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

function sanitizeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function incrementDailyModelUsage(
  delta: DailyModelUsageDelta,
  ts: number = Date.now(),
): Promise<void> {
  // 每 (天, agent, 模型, 币种) 一行,各币种各自累加。异币种金额不再被丢弃,也不再覆盖
  // 当天该模型的已有累计 —— 账本币种会因为换号、跨租户、上游漏发币种而切换,那两种
  // 做法都会静默丢账。
  const money = delta.money ? normalizeRegionalMoney(delta.money) : undefined;
  const ledgerCurrency = currentLedgerCurrency();
  if (money && money.currency !== ledgerCurrency) {
    log.warn(
      `daily model usage currency differs from ledger: ${money.currency} != ${ledgerCurrency}; ` +
        'recording into its own currency row',
    );
  }
  // 纯 token 行(无金额)归到当前账本币种,让它和同轮的金额落在同一行。
  const rowCurrency = money?.currency ?? ledgerCurrency;
  const inputTokens = sanitizeTokens(delta.inputTokensDelta);
  const outputTokens = sanitizeTokens(delta.outputTokensDelta);
  const cacheReadTokens = sanitizeTokens(delta.cacheReadTokensDelta);
  const cacheCreateTokens = sanitizeTokens(delta.cacheCreateTokensDelta);
  if (
    !money?.amount &&
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreateTokens === 0
  ) {
    return;
  }

  const day = localDayKey(ts);
  const model = delta.model || 'unknown';
  const db = getDbClient().drizzle;
  await db
    .insert(dailyModelUsage)
    .values({
      day,
      agentKind: delta.agentKind,
      model,
      costAmount: money?.amount ?? 0,
      costCurrency: rowCurrency,
      costIsApproximate: money?.approximate ?? false,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [
        dailyModelUsage.day,
        dailyModelUsage.agentKind,
        dailyModelUsage.model,
        dailyModelUsage.costCurrency,
      ],
      set: {
        costAmount: sql`${dailyModelUsage.costAmount} + ${money?.amount ?? 0}`,
        costIsApproximate: sql`(${dailyModelUsage.costIsApproximate} OR ${money?.approximate ? 1 : 0})`,
        inputTokens: sql`${dailyModelUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${dailyModelUsage.outputTokens} + ${outputTokens}`,
        cacheReadTokens: sql`${dailyModelUsage.cacheReadTokens} + ${cacheReadTokens}`,
        cacheCreateTokens: sql`${dailyModelUsage.cacheCreateTokens} + ${cacheCreateTokens}`,
        updatedAt: ts,
      },
    })
    .run();
}

export async function getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]> {
  const rows = await getDbClient()
    .drizzle.select({
      day: dailyModelUsage.day,
      agentKind: dailyModelUsage.agentKind,
      model: dailyModelUsage.model,
      costUsd: dailyModelUsage.costUsd,
      costAmount: dailyModelUsage.costAmount,
      costCurrency: dailyModelUsage.costCurrency,
      costIsApproximate: dailyModelUsage.costIsApproximate,
      inputTokens: dailyModelUsage.inputTokens,
      outputTokens: dailyModelUsage.outputTokens,
      cacheReadTokens: dailyModelUsage.cacheReadTokens,
      cacheCreateTokens: dailyModelUsage.cacheCreateTokens,
    })
    .from(dailyModelUsage)
    .where(sql`${dailyModelUsage.day} >= ${sinceDayKey}`)
    .all();
  return rows.map((row) => {
    const legacy = legacyUsdMoney(row.costUsd);
    const current =
      row.costCurrency && row.costAmount > 0
        ? normalizeRegionalMoney({
            amount: row.costAmount,
            currency: row.costCurrency,
            approximate: row.costIsApproximate,
            kind: 'actual-cost',
          })
        : undefined;
    return {
      day: row.day,
      agentKind: row.agentKind,
      model: row.model,
      money:
        legacy.amount > 0 && current
          ? legacy.currency === current.currency
            ? addRegionalMoney([legacy, current])
            : current
          : (current ?? (legacy.amount > 0 ? legacy : zeroUsageMoney())),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreateTokens: row.cacheCreateTokens,
    };
  });
}
