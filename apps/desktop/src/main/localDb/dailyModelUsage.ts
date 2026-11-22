import type { UsageAttribution } from './worker/opHandlers/modelUsageTx.js';
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
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';


export interface DailyModelUsageDelta {
  attribution?: UsageAttribution;
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
  requestCount?: number;
  source?: string;
  providerId?: string;
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

  // An unpriced token row can use the default bucket. Priced rows use the quote currency.
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
  await getDbClient().tx('usage.recordModelUsage', {
    day, agentKind: delta.agentKind, model, currency: rowCurrency,
    amount: money?.amount ?? 0, approximate: money?.approximate ?? false,
    inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
    recordedAt: ts, attribution: delta.attribution,
  });
}

export async function getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]> {
  const client = getDbClient();
  const rows = await client.drizzle
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
  const auxiliary = await client.query<DailyModelUsageRow>(
    `SELECT day, 'auxiliary' AS agentKind, model, source, provider_id AS providerId, COUNT(*) AS requestCount,
    SUM(COALESCE(input_tokens, 0)) AS inputTokens, SUM(COALESCE(output_tokens, 0)) AS outputTokens,
    SUM(COALESCE(cache_read_tokens, 0)) AS cacheReadTokens, SUM(COALESCE(cache_create_tokens, 0)) AS cacheCreateTokens
    FROM auxiliary_usage_receipts WHERE day >= ? GROUP BY day, model, source, provider_id`,
    [sinceDayKey],
  );
  return [
    ...rows.map((row) => {
      const isSubscriptionValue = row.model.endsWith('#billing=subscription');
      const isExplicitUnpricedSubscription =
        isSubscriptionValue && row.costAmount === 0 && Boolean(row.costIsApproximate);
      const legacy = legacyUsdMoney(row.costUsd);
      const current =
        row.costCurrency && (row.costAmount > 0 || isExplicitUnpricedSubscription)
          ? normalizeRegionalMoney({
              amount: row.costAmount,
              currency: row.costCurrency,
              approximate: isSubscriptionValue || row.costIsApproximate,
              kind: isSubscriptionValue ? 'value-estimate' : 'actual-cost',
              ...(isSubscriptionValue
                ? { estimateReasons: ['subscription-value', 'reference-price'] }
                : {}),
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
    }),
    ...auxiliary.map((row) => ({ ...row, money: zeroUsageMoney() })),
  ];
}
