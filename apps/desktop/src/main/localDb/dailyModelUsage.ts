import { sql } from 'drizzle-orm';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  addRegionalMoney,
  normalizeRegionalMoney,
  regionalCurrencyForRegion,
  regionalizeLegacyUsd,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailyModelUsage } from './schema.js';
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';

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
  if (money && money.currency !== regionalCurrencyForRegion(CURRENT_CINDY_REGION)) {
    throw new Error('daily model usage currency mismatch');
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
  const existing = await db
    .select({ costCurrency: dailyModelUsage.costCurrency })
    .from(dailyModelUsage)
    .where(
      sql`${dailyModelUsage.day} = ${day}
        AND ${dailyModelUsage.agentKind} = ${delta.agentKind}
        AND ${dailyModelUsage.model} = ${model}`,
    )
    .get();
  if (
    money &&
    existing?.costCurrency &&
    existing.costCurrency !== money.currency
  ) {
    throw new Error('daily model usage row has conflicting currency');
  }
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
        costAmount: sql`${dailyModelUsage.costAmount} + ${money?.amount ?? 0}`,
        ...(money ? { costCurrency: money.currency } : {}),
        costIsApproximate: sql`${dailyModelUsage.costIsApproximate} OR ${money?.approximate ? 1 : 0}`,
        inputTokens: sql`${dailyModelUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${dailyModelUsage.outputTokens} + ${outputTokens}`,
        cacheReadTokens: sql`${dailyModelUsage.cacheReadTokens} + ${cacheReadTokens}`,
        cacheCreateTokens: sql`${dailyModelUsage.cacheCreateTokens} + ${cacheCreateTokens}`,
        updatedAt: ts,
      },
    })
    .run();
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
    const legacy = regionalizeLegacyUsd(row.costUsd, CURRENT_CINDY_REGION);
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
