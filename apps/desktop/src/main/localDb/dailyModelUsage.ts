import { sql } from 'drizzle-orm';

import {
  addRegionalMoney,
  DEFAULT_USAGE_CURRENCY,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailyModelUsage } from './schema.js';
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('localDb/dailyModelUsage');

export interface DailyModelUsageDelta {
  agentKind: 'claude-code' | 'codex';
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
  const normalizedMoney = delta.money ? normalizeRegionalMoney(delta.money) : undefined;
  const money =
    normalizedMoney?.currency === DEFAULT_USAGE_CURRENCY
      ? normalizedMoney
      : undefined;
  if (normalizedMoney && !money) {
    log.warn(
      `daily model usage rejected currency mismatch: ${normalizedMoney.currency} != ${DEFAULT_USAGE_CURRENCY}`,
    );
  }
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
  // 单币种行:错误币种金额被忽略但 token 仍累计。升级前当天若仍是旧币种，
  // 首笔当前币种费用重新起算该金额列；历史 token 不受币种影响继续累计。
  const sameCurrency = money
    ? sql`(${dailyModelUsage.costCurrency} IS NULL OR ${dailyModelUsage.costCurrency} = ${money.currency})`
    : sql`0`;
  await db
    .insert(dailyModelUsage)
    .values({
      day,
      agentKind: delta.agentKind,
      model,
      costAmount: money?.amount ?? 0,
      costCurrency: money?.currency ?? null,
      costIsApproximate: money?.approximate ?? false,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [dailyModelUsage.day, dailyModelUsage.agentKind, dailyModelUsage.model],
      set: {
        costAmount: money
          ? sql`CASE WHEN ${sameCurrency} THEN ${dailyModelUsage.costAmount} + ${money.amount} ELSE ${money.amount} END`
          : sql`${dailyModelUsage.costAmount}`,
        costCurrency: money?.currency ?? sql`${dailyModelUsage.costCurrency}`,
        costIsApproximate: money
          ? sql`CASE WHEN ${sameCurrency} THEN (${dailyModelUsage.costIsApproximate} OR ${money.approximate ? 1 : 0}) ELSE ${money.approximate ? 1 : 0} END`
          : sql`${dailyModelUsage.costIsApproximate}`,
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
