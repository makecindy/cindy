import { supplementalConversationEstimates } from '@cindy/maker-shared/usage-cost-details';
import { resolveStaleCodexSubscriptionValueEstimate } from './codexSubscriptionValue.js';
import { normalizeRegionalMoney, usdMoney, USD_TO_CNY_FIXED_RATE, asValueEstimateMoney, type RegionalMoney } from './regionalMoney.js';
import { normalizeTurnUsageDetails } from './turnUsageDetails.js';

function correctStaleUsdEstimate(
  money: RegionalMoney,
  turnUsageDetails: unknown,
  model?: string,
): RegionalMoney {
  const reasons = money.estimateReasons ?? [];
  const isLegacyCnyProjection =
    money.currency === 'CNY' &&
    reasons.includes('legacy-usd') &&
    reasons.includes('fixed-fx');
  if (money.currency !== 'USD' && !isLegacyCnyProjection) return money;
  const amountUsd = isLegacyCnyProjection
    ? money.amount / USD_TO_CNY_FIXED_RATE
    : money.amount;
  const corrected = resolveStaleCodexSubscriptionValueEstimate(
    amountUsd,
    normalizeTurnUsageDetails(turnUsageDetails),
    model,
  );
  if (corrected == null) return money;
  return {
    ...money,
    amount: isLegacyCnyProjection
      ? corrected * USD_TO_CNY_FIXED_RATE
      : corrected,
  };
}

export function legacyEstimateMoney(costUsd: number): RegionalMoney | null {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return usdMoney(costUsd, 'value-estimate', 'legacy-usd');
}

export function turnEstimateAmounts(
  meta: { turnCost?: unknown; turnCostUsd?: unknown; turnCostIsEstimate?: boolean; turnUsageDetails?: unknown; model?: string },
): RegionalMoney[] {
  const primary = normalizeRegionalMoney(meta.turnCost);
  const supplemental = supplementalConversationEstimates(meta).map(asValueEstimateMoney);
  const estimates: RegionalMoney[] = [];
  if (meta.turnCostIsEstimate || primary?.kind === 'value-estimate') {
    const value = primary ?? (typeof meta.turnCostUsd === 'number' ? legacyEstimateMoney(meta.turnCostUsd) : null);
    if (value && value.amount > 0) {
      const estimate = asValueEstimateMoney(value);
      estimates.push(supplemental.length ? estimate : correctStaleUsdEstimate(estimate, meta.turnUsageDetails, meta.model));
    }
  }
  return [...estimates, ...supplemental];
}
