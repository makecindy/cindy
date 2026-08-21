import { BUILTIN_PROVIDERS, type ProviderView } from '@cindy/model-providers';

import {
  addCompatibleRegionalMoney,
  type RegionalMoney,
  type SdkCostPresentation,
} from './regionalMoney.js';

const BUILTIN_PROVIDER_IDS = new Set([
  ...BUILTIN_PROVIDERS.map((provider) => provider.id),
  // Pi persists the XD gateway aggregate route under this compatibility id.
  'cindy',
]);

/**
 * Billing must fail closed for a non-empty provider id that no longer exists in the active
 * catalog. That covers deleted custom providers and older/remote catalog snapshots without
 * briefly exposing their persisted SDK amounts as actual spend.
 */
export function isCustomProviderForBilling(
  providerId: string | null | undefined,
  providers: readonly Pick<ProviderView, 'id' | 'source'>[],
): boolean {
  if (!providerId || BUILTIN_PROVIDER_IDS.has(providerId)) return false;
  return providers.find((provider) => provider.id === providerId)?.source !== 'builtin';
}

/**
 * New rows persist an explicit per-turn flag. Pre-upgrade rows omit it, so fall
 * back to the session/schedule provider: unknown non-builtin ids fail closed.
 */
export function resolveCustomProviderCostFlag(
  explicit: unknown,
  fallbackProviderId?: string | null,
): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  return isCustomProviderForBilling(fallbackProviderId, []);
}

export function isSdkEstimateMoney(money: RegionalMoney | null | undefined): boolean {
  return money?.estimateReasons?.includes('sdk-estimate') === true;
}

function asSdkEstimateMoney(money: RegionalMoney): RegionalMoney {
  const reasons = (money.estimateReasons ?? []).filter(
    (reason) => reason !== 'subscription-value' && reason !== 'reference-price',
  );
  return {
    ...money,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: [...new Set([...reasons, 'sdk-estimate' as const])],
  };
}

/**
 * Projects an SDK-reported amount for display without mutating the persisted ledger fact.
 * Reference-price and user-override estimates remain visible when SDK estimates are hidden.
 */
export function projectSdkCostMoney(
  money: RegionalMoney | null | undefined,
  presentation: SdkCostPresentation,
): RegionalMoney | null {
  if (!money) return null;
  if (presentation === 'regular') return money;
  if (money.kind === 'value-estimate') {
    return presentation === 'hidden' && isSdkEstimateMoney(money) ? null : money;
  }
  return presentation === 'estimate' ? asSdkEstimateMoney(money) : null;
}

/**
 * A turn can contain both a provider/reference estimate and an SDK fallback estimate. When the
 * SDK part is hidden, rebuild the visible total from the per-model breakdown instead of dropping
 * the independent reference-price part with it.
 */
export function projectSdkCostMoneyWithBreakdown(
  money: RegionalMoney | null | undefined,
  perModelMoney: readonly RegionalMoney[] | null | undefined,
  presentation: SdkCostPresentation,
): RegionalMoney | null {
  const projected = projectSdkCostMoney(money, presentation);
  if (projected || presentation !== 'hidden' || !perModelMoney?.length) return projected;
  const visible = perModelMoney.flatMap((entry) => {
    const next = projectSdkCostMoney(entry, presentation);
    return next ? [next] : [];
  });
  return addCompatibleRegionalMoney(visible);
}

/**
 * Returns only the SDK-reported portion of a turn estimate.
 *
 * Claude can aggregate several model buckets into one turn amount. When that aggregate contains
 * both a reference quote and an SDK fallback, the aggregate reasons alone cannot tell us how much
 * to hide. The per-model breakdown is authoritative for the independently visible portion; any
 * remaining amount belongs to the SDK estimate. Historical custom-provider rows were persisted as
 * actual cost, so their full amount is projected into this SDK-estimate sub-ledger as well.
 */
export function sdkEstimatedValuePart(
  money: RegionalMoney | null | undefined,
  perModelMoney: readonly RegionalMoney[] | null | undefined,
  isCustomProviderCost: boolean | undefined,
): RegionalMoney | null {
  if (!money || money.amount <= 0) return null;
  if (money.kind === 'actual-cost') {
    return isCustomProviderCost === true || isSdkEstimateMoney(money)
      ? asSdkEstimateMoney(money)
      : null;
  }
  if (!isSdkEstimateMoney(money)) return null;
  if (!perModelMoney?.length) return asSdkEstimateMoney(money);

  const visible = perModelMoney.flatMap((entry) => {
    const projected = projectSdkCostMoney(entry, 'hidden');
    return projected ? [projected] : [];
  });
  const visibleMoney = addCompatibleRegionalMoney(visible, money.currency);
  const visibleAmount =
    visibleMoney?.currency === money.currency
      ? Math.min(money.amount, visibleMoney.amount)
      : 0;
  const amount = Math.max(0, money.amount - visibleAmount);
  return amount > 0 ? asSdkEstimateMoney({ ...money, amount }) : null;
}

/**
 * New rows carry an immutable per-turn custom-provider classification. Older rows fall back to
 * the session-level policy so pre-upgrade custom-provider SDK amounts still hide by default.
 */
export function resolveTurnSdkCostPresentation(args: {
  money: RegionalMoney | null | undefined;
  isCustomProviderCost: boolean | undefined;
  fallback: SdkCostPresentation;
  showSdkEstimate: boolean;
}): SdkCostPresentation {
  if (isSdkEstimateMoney(args.money)) return args.showSdkEstimate ? 'estimate' : 'hidden';
  // Explicit reference/user-price estimates are independent of the SDK fallback preference.
  // Keep them visible even when the turn itself came from a custom provider.
  if (args.money?.kind === 'value-estimate') return 'regular';
  if (args.isCustomProviderCost === true) {
    return args.showSdkEstimate ? 'estimate' : 'hidden';
  }
  if (args.isCustomProviderCost === false) return 'regular';
  return args.fallback;
}
