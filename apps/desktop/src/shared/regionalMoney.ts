import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export type MoneyCurrency = 'CNY' | 'USD';
export type MoneyKind = 'actual-cost' | 'value-estimate';
export type MoneyEstimateReason =
  'fixed-fx' | 'legacy-usd' | 'subscription-value' | 'reference-price';

export interface RegionalMoney {
  amount: number;
  currency: MoneyCurrency;
  approximate: boolean;
  kind: MoneyKind;
  estimateReasons?: MoneyEstimateReason[];
}

export interface ModelPriceQuote {
  providerId: string;
  modelId: string;
  currency: MoneyCurrency;
  source: 'gateway' | 'provider-reference' | 'subscription-reference';
  approximate: boolean;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheCreatePerMtok?: number;
}

export type ModelPricingCatalog = Record<string, Record<string, ModelPriceQuote>>;

export const USD_TO_CNY_FIXED_RATE = 6.7;

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`invalid non-negative money amount: ${String(amount)}`);
  }
}

function uniqueReasons(
  reasons: ReadonlyArray<MoneyEstimateReason | undefined>,
): MoneyEstimateReason[] | undefined {
  const out = [...new Set(reasons.filter((reason): reason is MoneyEstimateReason => !!reason))];
  return out.length > 0 ? out : undefined;
}

export function gatewayCurrencyForRegion(region: CindyRegion): MoneyCurrency {
  return region === 'global' ? 'USD' : 'CNY';
}

export function regionalCurrencyForRegion(region: CindyRegion): MoneyCurrency {
  return gatewayCurrencyForRegion(region);
}

export function zeroRegionalMoney(
  region: CindyRegion,
  kind: MoneyKind = 'actual-cost',
): RegionalMoney {
  return {
    amount: 0,
    currency: regionalCurrencyForRegion(region),
    approximate: kind === 'value-estimate',
    kind,
    ...(kind === 'value-estimate' ? { estimateReasons: ['subscription-value'] } : {}),
  };
}

export function regionalizeUsd(
  amountUsd: number,
  region: CindyRegion,
  reason: MoneyEstimateReason,
  kind: MoneyKind = 'actual-cost',
): RegionalMoney {
  assertAmount(amountUsd);
  const convert = region !== 'global';
  const approximateConversion = convert && amountUsd !== 0;
  const approximate = approximateConversion || kind === 'value-estimate';
  const estimateReasons = approximate
    ? uniqueReasons([
        approximateConversion ? 'fixed-fx' : undefined,
        reason,
        kind === 'value-estimate' ? 'subscription-value' : undefined,
      ])
    : undefined;
  return {
    amount: convert ? amountUsd * USD_TO_CNY_FIXED_RATE : amountUsd,
    currency: convert ? 'CNY' : 'USD',
    approximate,
    kind,
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

export function gatewayMoney(
  amount: number,
  region: CindyRegion,
  kind: MoneyKind = 'actual-cost',
): RegionalMoney {
  assertAmount(amount);
  const approximate = kind === 'value-estimate';
  return {
    amount,
    currency: gatewayCurrencyForRegion(region),
    approximate,
    kind,
    ...(approximate ? { estimateReasons: ['subscription-value'] } : {}),
  };
}

export function addRegionalMoney(values: readonly RegionalMoney[]): RegionalMoney {
  if (values.length === 0) throw new Error('cannot add an empty money list');
  const currency = values[0].currency;
  if (values.some((value) => value.currency !== currency)) {
    throw new Error('cannot add money with different currencies');
  }
  for (const value of values) assertAmount(value.amount);
  const approximate = values.some((value) => value.approximate);
  const estimateReasons = uniqueReasons(values.flatMap((value) => value.estimateReasons ?? []));
  return {
    amount: values.reduce((sum, value) => sum + value.amount, 0),
    currency,
    approximate,
    kind: values.some((value) => value.kind === 'actual-cost') ? 'actual-cost' : 'value-estimate',
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

/**
 * Read-side compatibility for persisted/history projections.
 *
 * Writers must keep using addRegionalMoney() so currency drift is rejected.
 * Readers may encounter stale mixed-currency data after a region change. In
 * that case actual cost determines the currency before estimates, and the
 * preferred regional currency wins when multiple actual currencies exist.
 */
export function addCompatibleRegionalMoney(
  values: readonly RegionalMoney[],
  preferredCurrency: MoneyCurrency,
): RegionalMoney | null {
  if (values.length === 0) return null;
  const actualValues = values.filter((value) => value.kind === 'actual-cost');
  const currencyCandidates = actualValues.length > 0 ? actualValues : values;
  const currency =
    currencyCandidates.find((value) => value.currency === preferredCurrency)?.currency ??
    currencyCandidates[0].currency;
  const compatible = values.filter((value) => value.currency === currency);
  return compatible.length > 0 ? addRegionalMoney(compatible) : null;
}

export function asValueEstimateMoney(money: RegionalMoney): RegionalMoney {
  assertAmount(money.amount);
  return {
    ...money,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: uniqueReasons([...(money.estimateReasons ?? []), 'subscription-value']),
  };
}

export function regionalizeLegacyUsd(amountUsd: number, region: CindyRegion): RegionalMoney {
  return regionalizeUsd(amountUsd, region, 'legacy-usd');
}

export function regionalAmountFromUsdReference(amountUsd: number, region: CindyRegion): number {
  assertAmount(amountUsd);
  return region === 'global' ? amountUsd : amountUsd * USD_TO_CNY_FIXED_RATE;
}

export function normalizeRegionalMoney(value: unknown): RegionalMoney | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<RegionalMoney>;
  if (
    !isNonNegativeAmount(raw.amount) ||
    (raw.currency !== 'CNY' && raw.currency !== 'USD') ||
    typeof raw.approximate !== 'boolean' ||
    (raw.kind !== 'actual-cost' && raw.kind !== 'value-estimate')
  ) {
    return undefined;
  }
  const estimateReasons = Array.isArray(raw.estimateReasons)
    ? uniqueReasons(
        raw.estimateReasons.filter(
          (reason): reason is MoneyEstimateReason =>
            reason === 'fixed-fx' ||
            reason === 'legacy-usd' ||
            reason === 'subscription-value' ||
            reason === 'reference-price',
        ),
      )
    : undefined;
  return {
    amount: raw.amount,
    currency: raw.currency,
    approximate: raw.approximate,
    kind: raw.kind,
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

function isNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
