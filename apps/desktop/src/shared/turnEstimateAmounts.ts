import { supplementalConversationEstimates } from '@cindy/maker-shared/usage-cost-details';
import { resolveStaleCodexSubscriptionValueEstimate } from './codexSubscriptionValue.js';
import { normalizeRegionalMoney, usdMoney, USD_TO_CNY_FIXED_RATE, type RegionalMoney } from './regionalMoney.js';
import { normalizeTurnUsageDetails, type TurnUsageDetails } from './turnUsageDetails.js';

/** Classify the model estimate independently of separately charged media. */
export function hasSubscriptionEstimateSource(
  money: RegionalMoney | undefined,
  details?: TurnUsageDetails,
): boolean {
  if (details?.perModelCost?.length) {
    return details.perModelCost.every(row =>
      row.money.kind === 'value-estimate' &&
      hasSubscriptionSource(row.money, row.billingSource ?? details.billingSource),
    );
  }
  return hasSubscriptionSource(money, details?.billingSource);
}

function hasSubscriptionSource(money: RegionalMoney | undefined, source: TurnUsageDetails['billingSource']): boolean {
  if (source && source !== 'unknown') return source === 'subscription';
  const reasons = money?.estimateReasons;
  return reasons?.includes('subscription-value') === true &&
    (!reasons.includes('legacy-usd') || money?.subscriptionSourceConfirmed === true);
}

function withEstimateSource(money: RegionalMoney, details: TurnUsageDetails | undefined): RegionalMoney {
  const reasons = money.estimateReasons ?? [];
  const subscription = hasSubscriptionEstimateSource(money, details);
  const estimateReasons = subscription
    ? [...new Set([...reasons, 'subscription-value' as const])]
    : reasons.filter(reason => reason !== 'subscription-value');
  const { subscriptionSourceConfirmed: _confirmation, ...value } = money;
  return {
    ...value,
    kind: 'value-estimate',
    approximate: true,
    estimateReasons,
    ...(subscription && reasons.includes('legacy-usd') ? { subscriptionSourceConfirmed: true } : {}),
  };
}

function correctStaleUsdEstimate(
  money: RegionalMoney,
  turnUsageDetails: TurnUsageDetails | undefined,
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
    turnUsageDetails,
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
  const hasPrimaryEstimate = meta.turnCostIsEstimate === true || primary?.kind === 'value-estimate';
  const supplementalAmounts = supplementalConversationEstimates(meta);
  if (!hasPrimaryEstimate && !supplementalAmounts.length) return [];
  const details = normalizeTurnUsageDetails(meta.turnUsageDetails);
  const supplemental = supplementalAmounts.map(money => {
    const rows = details?.perModelCost?.filter(row => row.money.currency === money.currency && row.money.kind === 'value-estimate');
    return withEstimateSource(money, details && { ...details, perModelCost: rows });
  });
  const estimates: RegionalMoney[] = [];
  if (hasPrimaryEstimate) {
    const value = primary ?? (typeof meta.turnCostUsd === 'number' ? legacyEstimateMoney(meta.turnCostUsd) : null);
    if (value && value.amount > 0) {
      // Legacy USD keeps its compatibility markers. A recorded channel, when
      // present, supplies a stronger description of the estimate.
      const estimate = primary || details?.billingSource || details?.perModelCost?.length
        ? withEstimateSource(value, details)
        : value;
      estimates.push(supplemental.length ? estimate : correctStaleUsdEstimate(estimate, details, meta.model));
    }
  }
  return [...estimates, ...supplemental];
}
