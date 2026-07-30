import type {
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingPaymentOrder,
  BillingPurchaseOption,
  BillingSubscription,
} from '../../../shared/billing';

export type BillingPurchaseType = 'ONE_TIME' | 'RECURRING' | 'UNKNOWN';

export type RolloverProjection = {
  cap: string;
  eligibleToCarryOver: string | null;
  estimatedExpired: string | null;
  settlementAt: string | null;
};

export function purchaseTypeOf(option: Pick<BillingPurchaseOption, 'capability'>): BillingPurchaseType {
  if (option.capability === 'ONE_TIME_PAYMENT') return 'ONE_TIME';
  if (
    option.capability === 'MERCHANT_INITIATED_MANDATE' ||
    option.capability === 'PROVIDER_MANAGED_SUBSCRIPTION'
  ) {
    return 'RECURRING';
  }
  return 'UNKNOWN';
}

export function purchaseTypeForOffer(offer: BillingCatalogOffer): BillingPurchaseType {
  const types = new Set(offer.purchaseOptions.map(purchaseTypeOf));
  if (types.size !== 1) return 'UNKNOWN';
  return [...types][0] ?? 'UNKNOWN';
}

export function purchaseTypeForSubscription(
  subscription: BillingSubscription,
  offer: BillingCatalogOffer | null,
): BillingPurchaseType {
  if (offer) return purchaseTypeForOffer(offer);
  if (subscription.status === 'ACTIVE' && !subscription.cancelAtPeriodEnd) return 'RECURRING';
  return 'UNKNOWN';
}

export function rolloverProjection(
  planRemaining: string | null,
  rolloverCap: string | null,
  settlementAt: string | null,
): RolloverProjection | null {
  if (!rolloverCap) return null;
  if (planRemaining === null || settlementAt === null) {
    return { cap: rolloverCap, eligibleToCarryOver: null, estimatedExpired: null, settlementAt };
  }
  const remaining = decimalUnits(planRemaining);
  const cap = decimalUnits(rolloverCap);
  if (remaining === null || cap === null || remaining < 0n || cap < 0n) {
    return { cap: rolloverCap, eligibleToCarryOver: null, estimatedExpired: null, settlementAt };
  }
  const carry = remaining < cap ? remaining : cap;
  const expired = remaining > cap ? remaining - cap : 0n;
  return {
    cap: rolloverCap,
    eligibleToCarryOver: formatUnits(carry),
    estimatedExpired: formatUnits(expired),
    settlementAt,
  };
}

export function productNameForOffer(
  products: BillingCatalogProduct[],
  offerCode: string | null | undefined,
): string | null {
  if (!offerCode) return null;
  for (const product of products) {
    if (product.offers.some((offer) => offer.code === offerCode)) return product.name;
  }
  return null;
}

export function orderPurchaseType(
  order: BillingPaymentOrder,
  products: BillingCatalogProduct[],
): BillingPurchaseType {
  const offer = products
    .flatMap((product) => product.offers)
    .find((candidate) => candidate.code === order.offerCode);
  return offer ? purchaseTypeForOffer(offer) : 'UNKNOWN';
}

function decimalUnits(value: string): bigint | null {
  const match = /^(0|[1-9]\d{0,14})(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0') || '0');
}

function formatUnits(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
