import type { TurnUsageDetails } from './turnUsageDetails';

/** Price shape used only for Codex OAuth subscription value estimates. */
export interface CodexSubscriptionValuePrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok?: number;
  cacheCreateUsdPerMtok?: number;
}

/**
 * Codex OAuth subscription sessions do not have a real API bill. This table is
 * the reference "session value" display price, not `sessions.total_cost_usd`.
 */
export const CODEX_SUBSCRIPTION_VALUE_PRICING: Record<string, CodexSubscriptionValuePrice> = {
  // GPT-5.6 (2026-07-09 GA): cache read = 10% input; 自 5.6 起 cache write 按官方
  // 1.25x uncached input 计费 (此前 GPT 系列自动缓存写入不加价, 故老条目不挂该档)。
  'gpt-5.6-sol': { inputUsdPerMtok: 5, cacheReadUsdPerMtok: 0.5, cacheCreateUsdPerMtok: 6.25, outputUsdPerMtok: 30 },
  'gpt-5.6-terra': { inputUsdPerMtok: 2.5, cacheReadUsdPerMtok: 0.25, cacheCreateUsdPerMtok: 3.125, outputUsdPerMtok: 15 },
  'gpt-5.6-luna': { inputUsdPerMtok: 1, cacheReadUsdPerMtok: 0.1, cacheCreateUsdPerMtok: 1.25, outputUsdPerMtok: 6 },
  'gpt-5.5': { inputUsdPerMtok: 5, cacheReadUsdPerMtok: 0.5, outputUsdPerMtok: 30 },
  'gpt-5.4': { inputUsdPerMtok: 2.5, cacheReadUsdPerMtok: 0.25, outputUsdPerMtok: 15 },
  'gpt-5.4-mini': { inputUsdPerMtok: 0.75, cacheReadUsdPerMtok: 0.075, outputUsdPerMtok: 4.5 },
};

/** Previous embedded fallback table, used only to recognize stale persisted estimates. */
const LEGACY_CODEX_SUBSCRIPTION_VALUE_PRICING: Record<string, CodexSubscriptionValuePrice> = {
  'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
  'gpt-5.4': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
  'gpt-5.4-mini': { inputUsdPerMtok: 0.75, outputUsdPerMtok: 4.5 },
};

/** Normalize model ids persisted by different Codex event paths. */
export function normalizeCodexSubscriptionValueModelId(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/\[[^\]]*\]\s*$/, '').trim() || 'unknown';
}

/** Recompute Codex subscription value from token buckets so cached input is not priced as fresh input. */
export function estimateCodexSubscriptionValueFromTurnUsage(
  details: TurnUsageDetails | null | undefined,
  modelOverride?: string | null,
): number | null {
  if (!details) return null;
  const detailsModel = normalizeCodexSubscriptionValueModelId(details.model);
  const model = detailsModel !== 'unknown'
    ? detailsModel
    : normalizeCodexSubscriptionValueModelId(modelOverride);
  const price = CODEX_SUBSCRIPTION_VALUE_PRICING[model];
  if (!price) return null;
  const inputTokens = Math.max(0, details.inputTokens || 0);
  const outputTokens = Math.max(0, details.outputTokens || 0);
  const cacheReadTokens = Math.max(0, details.cacheReadTokens || 0);
  const cacheCreateTokens = Math.max(0, details.cacheCreateTokens || 0);
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens <= 0) return null;
  const cacheReadPrice = price.cacheReadUsdPerMtok ?? price.inputUsdPerMtok;
  const cacheCreatePrice = price.cacheCreateUsdPerMtok ?? price.inputUsdPerMtok;
  return (
    (inputTokens * price.inputUsdPerMtok +
      outputTokens * price.outputUsdPerMtok +
      cacheReadTokens * cacheReadPrice +
      cacheCreateTokens * cacheCreatePrice) /
    1e6
  );
}

/**
 * Return a corrected estimate only when a persisted value looks like the old
 * bug: cached tokens were priced as fresh input. Otherwise keep the stored
 * value because main may have used live gateway pricing that is not available
 * on historical renderer/main read paths.
 */
export function resolveStaleCodexSubscriptionValueEstimate(
  rawCostUsd: number,
  details: TurnUsageDetails | null | undefined,
  modelOverride?: string | null,
): number | null {
  if (!Number.isFinite(rawCostUsd) || rawCostUsd <= 0 || !details) return null;
  const detailsModel = normalizeCodexSubscriptionValueModelId(details.model);
  const model = detailsModel !== 'unknown'
    ? detailsModel
    : normalizeCodexSubscriptionValueModelId(modelOverride);
  const price = CODEX_SUBSCRIPTION_VALUE_PRICING[model];
  if (!price) return null;

  const inputTokens = Math.max(0, details.inputTokens || 0);
  const outputTokens = Math.max(0, details.outputTokens || 0);
  const cacheReadTokens = Math.max(0, details.cacheReadTokens || 0);
  const cacheCreateTokens = Math.max(0, details.cacheCreateTokens || 0);
  if (cacheReadTokens + cacheCreateTokens <= 0) return null;

  const corrected = estimateCodexSubscriptionValueFromTurnUsage(details, model);
  if (corrected == null || !Number.isFinite(corrected) || corrected <= 0) return null;

  const candidatePrices = [price, LEGACY_CODEX_SUBSCRIPTION_VALUE_PRICING[model]].filter(
    (candidatePrice): candidatePrice is CodexSubscriptionValuePrice => Boolean(candidatePrice),
  );
  for (const candidatePrice of candidatePrices) {
    const oldFullCacheEstimate = (
      inputTokens * candidatePrice.inputUsdPerMtok +
      outputTokens * candidatePrice.outputUsdPerMtok +
      cacheReadTokens * candidatePrice.inputUsdPerMtok +
      cacheCreateTokens * candidatePrice.inputUsdPerMtok
    ) / 1e6;
    if (!Number.isFinite(oldFullCacheEstimate) || oldFullCacheEstimate <= corrected) continue;

    const tolerance = Math.max(0.000001, oldFullCacheEstimate * 0.001);
    if (Math.abs(rawCostUsd - oldFullCacheEstimate) <= tolerance) return corrected;
  }
  return null;
}
