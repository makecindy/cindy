import type {
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingPaymentOrder,
  BillingPurchaseOption,
  BillingSubscription,
} from '../../../../shared/billing';
import {
  orderPurchaseType,
  productNameForOffer,
  purchaseTypeForOffer,
  purchaseTypeForSubscription,
  purchaseTypeOf,
  rolloverProjection,
} from '../presentation';

function option(capability: BillingPurchaseOption['capability']): BillingPurchaseOption {
  return {
    id: `option-${capability}`,
    provider: 'stripe',
    paymentAction: 'REDIRECT',
    capability,
  };
}

function offer(
  capability: BillingPurchaseOption['capability'],
  overrides: Partial<BillingCatalogOffer> = {},
): BillingCatalogOffer {
  return {
    code: 'plus-monthly',
    interval: 'MONTH',
    currency: 'USD',
    amount: '10',
    minAmount: null,
    maxAmount: null,
    creditAmount: '100',
    rolloverCap: '20',
    purchaseOptions: [option(capability)],
    ...overrides,
  };
}

function subscription(overrides: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    subscriptionId: 'sub-1',
    purchaseAttemptId: null,
    status: 'ACTIVE',
    provider: 'stripe',
    cancelAtPeriodEnd: false,
    currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
    currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
    entitlementValidUntil: '2026-08-01T00:00:00.000Z',
    entitlementStatus: 'SUCCEEDED',
    effectivePlan: {
      product: { code: 'plus', level: 1 },
      offer: { code: 'plus-monthly', interval: 'MONTH' },
      terms: {
        amount: '10',
        currency: 'USD',
        creditAmount: '100',
        rolloverCap: '20',
      },
    },
    pendingPlanChange: null,
    paymentAction: null,
    ...overrides,
  };
}

test('classifies one-time and recurring capabilities', () => {
  expect(purchaseTypeOf(option('ONE_TIME_PAYMENT'))).toBe('ONE_TIME');
  expect(purchaseTypeOf(option('MERCHANT_INITIATED_MANDATE'))).toBe('RECURRING');
  expect(purchaseTypeOf(option('PROVIDER_MANAGED_SUBSCRIPTION'))).toBe('RECURRING');
});

test('does not infer recurring purchase type for canceled subscription without offer', () => {
  expect(purchaseTypeForSubscription(subscription({ cancelAtPeriodEnd: true }), null)).toBe('UNKNOWN');
  expect(purchaseTypeForSubscription(subscription({ status: 'PAST_DUE' }), null)).toBe('UNKNOWN');
});

test('uses offer capabilities and returns unknown for mixed options', () => {
  expect(purchaseTypeForOffer(offer('ONE_TIME_PAYMENT'))).toBe('ONE_TIME');
  expect(
    purchaseTypeForOffer(
      offer('ONE_TIME_PAYMENT', {
        purchaseOptions: [option('ONE_TIME_PAYMENT'), option('PROVIDER_MANAGED_SUBSCRIPTION')],
      }),
    ),
  ).toBe('UNKNOWN');
});

test('calculates rollover estimates with exact decimal units', () => {
  expect(rolloverProjection('25.125000001', '20.5', '2026-08-01T00:00:00.000Z')).toEqual({
    cap: '20.5',
    eligibleToCarryOver: '20.5',
    estimatedExpired: '4.625000001',
    settlementAt: '2026-08-01T00:00:00.000Z',
  });
  expect(rolloverProjection('10', '20', '2026-08-01T00:00:00.000Z')?.estimatedExpired).toBe('0');
});

test('omits derived rollover estimates when trusted inputs are missing or malformed', () => {
  expect(rolloverProjection(null, '20', '2026-08-01T00:00:00.000Z')).toMatchObject({
    cap: '20',
    eligibleToCarryOver: null,
    estimatedExpired: null,
  });
  expect(rolloverProjection('invalid', '20', '2026-08-01T00:00:00.000Z')?.estimatedExpired).toBeNull();
  expect(rolloverProjection('10', '20', null)?.eligibleToCarryOver).toBeNull();
});

test('resolves product and order purchase type from catalog', () => {
  const products: BillingCatalogProduct[] = [
    {
      code: 'plus',
      name: 'Plus',
      kind: 'SUBSCRIPTION',
      level: 1,
      sortOrder: 1,
      offers: [offer('PROVIDER_MANAGED_SUBSCRIPTION')],
    },
  ];
  const order = { offerCode: 'plus-monthly' } as BillingPaymentOrder;
  expect(productNameForOffer(products, 'plus-monthly')).toBe('Plus');
  expect(orderPurchaseType(order, products)).toBe('RECURRING');
  expect(orderPurchaseType({ offerCode: 'unknown' } as BillingPaymentOrder, products)).toBe('UNKNOWN');
});
