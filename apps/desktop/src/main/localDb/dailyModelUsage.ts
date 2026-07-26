import { sql } from 'drizzle-orm';

import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
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
  const money = delta.money ? normalizeRegionalMoney(delta.money) : undefined;
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
  // 单币种行:币种守卫必须在同一条 upsert 里用 CASE 表达 —— 先查再写有
  // TOCTOU 窗口,并发首写会把不同币种的裸数字加进同一行。冲突时原子地只弃
  // 金额,token 增量照记(throw 会连本轮 token 统计一起丢,损失更大)。
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
      target: [
        dailyModelUsage.day,
        dailyModelUsage.agentKind,
        dailyModelUsage.model,
      ],
      set: {
        costAmount: sql`CASE WHEN ${sameCurrency} THEN ${dailyModelUsage.costAmount} + ${money?.amount ?? 0} ELSE ${dailyModelUsage.costAmount} END`,
        costCurrency: sql`CASE WHEN ${sameCurrency} THEN ${money?.currency ?? null} ELSE ${dailyModelUsage.costCurrency} END`,
        costIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${dailyModelUsage.costIsApproximate} OR ${money?.approximate ? 1 : 0}) ELSE ${dailyModelUsage.costIsApproximate} END`,
        inputTokens: sql`${dailyModelUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${dailyModelUsage.outputTokens} + ${outputTokens}`,
        cacheReadTokens: sql`${dailyModelUsage.cacheReadTokens} + ${cacheReadTokens}`,
        cacheCreateTokens: sql`${dailyModelUsage.cacheCreateTokens} + ${cacheCreateTokens}`,
        updatedAt: ts,
      },
    })
    .run();
  if (money) {
    const row = await db
      .select({ costCurrency: dailyModelUsage.costCurrency })
      .from(dailyModelUsage)
      .where(
        sql`${dailyModelUsage.day} = ${day}
          AND ${dailyModelUsage.agentKind} = ${delta.agentKind}
          AND ${dailyModelUsage.model} = ${model}`,
      )
      .get();
    if (row?.costCurrency && row.costCurrency !== money.currency) {
      log.warn(
        `daily model usage currency conflict on ${day}/${delta.agentKind}/${model}: ` +
          `keeping ${row.costCurrency}, dropped ${money.currency} amount`,
      );
    }
  }
}

export async function getModelUsageSince(
  sinceDayKey: string,
): Promise<DailyModelUsageRow[]> {
  const rows = await getDbClient().drizzle
    .select({
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
          : current ?? legacy,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreateTokens: row.cacheCreateTokens,
    };
  });
}
