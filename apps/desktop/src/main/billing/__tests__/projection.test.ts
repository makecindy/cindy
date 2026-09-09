import { describe, expect, it } from 'vitest';

import {
  projectBillingCatalog,
  projectBillingCurrentSubscription,
  projectBillingOrderList,
  projectBillingPaymentOrder,
  projectBillingPlanChange,
  projectModelAccessBalance,
  projectModelAccessCreditUsage,
} from '../projection.js';

const now = '2026-07-23T12:00:00.000Z';

function order(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order_1',
    productCode: 'credit_topup',
    offerCode: 'credit_topup_20',
    amount: '20',
    currency: 'cny',
    status: 'PENDING',
    paymentAction: {
      type: 'REDIRECT',
      url: 'https://checkout.stripe.com/c/pay/session_fixture',
      expiresAt: now,
    },
    createdAt: now,
    updatedAt: now,
    internalProviderResponse: 'must not cross IPC',
    ...overrides,
  };
}

describe('billing response projection', () => {
  it('projects one exact ledger snapshot and strips server-only fields', () => {
    expect(
      projectModelAccessBalance({
        planCredits: '7.000000001',
        purchasedCredits: '-2.5',
        promotionalCredits: '0.499999999',
        available: '5',
        scale: 9,
        observedAt: '2026-07-23T12:00:00.123456789Z',
        tenantId: 'must not cross IPC',
      }),
    ).toEqual({
      planCredits: '7.000000001',
      purchasedCredits: '-2.5',
      promotionalCredits: '0.499999999',
      available: '5',
      scale: 9,
      observedAt: '2026-07-23T12:00:00.123456789Z',
    });
  });

  it('rejects inconsistent, negative protected-pool, and invalid-date balance snapshots', () => {
    const valid = {
      planCredits: '7',
      purchasedCredits: '5',
      promotionalCredits: '4',
      available: '16',
      scale: 9,
      observedAt: now,
    };

    expect(() => projectModelAccessBalance({ ...valid, available: '15.999999999' })).toThrow();
    expect(() =>
      projectModelAccessBalance({
        ...valid,
        planCredits: '-1',
        purchasedCredits: '13',
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessBalance({ ...valid, observedAt: '2026-02-31T12:00:00Z' }),
    ).toThrow();
  });

  it('projects exact pool usage and independent promotional grant states', () => {
    expect(
      projectModelAccessCreditUsage({
        available: '6',
        plan: { remaining: '3', used: '7', total: '10' },
        purchased: { remaining: '2', used: '3', total: '5' },
        promotional: { remaining: '1', used: '1', total: '2' },
        promotionalGrants: [
          {
            grantId: 'welcome',
            displayName: 'Welcome',
            originalAmount: '2',
            usedAmount: '1',
            remainingAmount: '1',
            expiresAt: '2026-08-01T00:00:00.123456789Z',
            state: 'active',
            internalMetadata: 'hidden',
          },
          {
            grantId: 'expired',
            displayName: null,
            originalAmount: '5',
            usedAmount: '1.25',
            remainingAmount: '0',
            expiresAt: '2026-07-01T00:00:00Z',
            state: 'expired',
          },
          {
            grantId: 'voided',
            displayName: 'Voided',
            originalAmount: '3',
            usedAmount: '0.5',
            remainingAmount: '0',
            expiresAt: '2026-08-01T00:00:00Z',
            state: 'voided',
          },
        ],
        promotionalGrantsComplete: true,
        promotionalGrantConsistency: 'OBSERVED',
        ledgerUpdatedAt: '2026-07-23T11:00:00Z',
        scale: 9,
        observedAt: '2026-07-23T12:00:00.123456789Z',
        serviceKey: 'must not cross IPC',
      }),
    ).toEqual({
      available: '6',
      plan: { remaining: '3', used: '7', total: '10' },
      purchased: { remaining: '2', used: '3', total: '5' },
      promotional: { remaining: '1', used: '1', total: '2' },
      promotionalGrants: [
        {
          grantId: 'welcome',
          displayName: 'Welcome',
          originalAmount: '2',
          usedAmount: '1',
          remainingAmount: '1',
          expiresAt: '2026-08-01T00:00:00.123456789Z',
          state: 'active',
        },
        {
          grantId: 'expired',
          displayName: null,
          originalAmount: '5',
          usedAmount: '1.25',
          remainingAmount: '0',
          expiresAt: '2026-07-01T00:00:00Z',
          state: 'expired',
        },
        {
          grantId: 'voided',
          displayName: 'Voided',
          originalAmount: '3',
          usedAmount: '0.5',
          remainingAmount: '0',
          expiresAt: '2026-08-01T00:00:00Z',
          state: 'voided',
        },
      ],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED',
      ledgerUpdatedAt: '2026-07-23T11:00:00Z',
      scale: 9,
      observedAt: '2026-07-23T12:00:00.123456789Z',
    });
  });

  it('rejects inconsistent pool identities and dishonest promotional histories', () => {
    const valid = {
      available: '6',
      plan: { remaining: '3', used: '7', total: '10' },
      purchased: { remaining: '2', used: '3', total: '5' },
      promotional: { remaining: '1', used: '1', total: '2' },
      promotionalGrants: [
        {
          grantId: 'welcome',
          displayName: null,
          originalAmount: '2',
          usedAmount: '1',
          remainingAmount: '1',
          expiresAt: '2026-08-01T00:00:00Z',
          state: 'active',
        },
      ],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED',
      ledgerUpdatedAt: null,
      scale: 9,
      observedAt: now,
    };

    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        plan: { remaining: '3', used: '8', total: '10' },
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotionalGrantsComplete: false,
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotional: { remaining: '0', used: '2', total: '2' },
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotional: { remaining: '1', used: '1', total: '2' },
        promotionalGrants: [
          {
            ...valid.promotionalGrants[0],
            usedAmount: '0.5',
            remainingAmount: '1.5',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotionalGrants: [valid.promotionalGrants[0], { ...valid.promotionalGrants[0] }],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotionalGrantConsistency: ['LAST', 'SETTLED'].join('_'),
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        observedAt: '2026-07-23T12:00:00.000000001Z',
        promotionalGrants: [
          {
            ...valid.promotionalGrants[0],
            expiresAt: '2026-07-23T12:00:00.000000002Z',
          },
        ],
      }),
    ).not.toThrow();

    const historical = {
      ...valid,
      available: '5',
      promotional: { remaining: '0', used: null, total: null },
      promotionalGrants: [
        {
          ...valid.promotionalGrants[0],
          state: 'expired',
          usedAmount: '1',
          remainingAmount: '0',
          expiresAt: '2026-07-01T00:00:00Z',
        },
      ],
      promotionalGrantsComplete: false,
    };
    expect(projectModelAccessCreditUsage(historical)).toMatchObject({
      promotionalGrants: [{ state: 'expired', usedAmount: '1', remainingAmount: '0' }],
    });
    expect(() =>
      projectModelAccessCreditUsage({
        ...historical,
        promotionalGrants: [{ ...historical.promotionalGrants[0], usedAmount: '2.000000001' }],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...historical,
        promotionalGrants: [
          {
            ...historical.promotionalGrants[0],
            state: 'voided',
            remainingAmount: '1',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...historical,
        promotionalGrants: [{ ...historical.promotionalGrants[0], usedAmount: null }],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotionalGrants: [
          {
            ...valid.promotionalGrants[0],
            state: 'active',
            usedAmount: '2',
            remainingAmount: '0',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      projectModelAccessCreditUsage({
        ...valid,
        promotionalGrants: [
          {
            ...valid.promotionalGrants[0],
            state: 'depleted',
            usedAmount: '1',
            remainingAmount: '1',
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps valid catalog entries while dropping malformed and unsupported nested entries', () => {
    const projected = projectBillingCatalog({
      products: [
        {
          code: 'credit_topup',
          name: 'Credits',
          kind: 'CREDIT_TOPUP',
          level: null,
          sortOrder: 1,
          internalField: 'hidden',
          offers: [
            {
              code: 'credit_topup_20',
              name: '20 credits',
              interval: null,
              currency: 'cny',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '20',
              rolloverCap: null,
              purchaseOptions: [
                {
                  id: 'listing_alipay',
                  provider: 'alipay',
                  capability: 'ONE_TIME_PAYMENT',
                  paymentAction: 'QR_CODE',
                  merchantId: 'hidden',
                },
                {
                  id: 'listing_future',
                  provider: 'future_provider',
                  capability: 'ONE_TIME_PAYMENT',
                  paymentAction: 'QR_CODE',
                },
                {
                  id: 'listing_future_action',
                  provider: 'stripe',
                  capability: 'ONE_TIME_PAYMENT',
                  paymentAction: 'EMBEDDED_WIDGET',
                },
                {
                  id: 'listing_future_capability',
                  provider: 'stripe',
                  capability: 'FUTURE_CAPABILITY',
                  paymentAction: 'REDIRECT',
                },
              ],
            },
            { code: 'broken', purchaseOptions: [] },
          ],
        },
        {
          code: 'future_product',
          name: 'Future',
          kind: 'USAGE_PACKAGE',
          level: null,
          sortOrder: 2,
          offers: [],
        },
      ],
    });

    expect(projected).toEqual({
      products: [
        {
          code: 'credit_topup',
          name: 'Credits',
          kind: 'CREDIT_TOPUP',
          level: null,
          sortOrder: 1,
          offers: [
            {
              code: 'credit_topup_20',
              name: '20 credits',
              interval: null,
              currency: 'cny',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '20',
              rolloverCap: null,
              purchaseOptions: [
                {
                  id: 'listing_alipay',
                  provider: 'alipay',
                  capability: 'ONE_TIME_PAYMENT',
                  paymentAction: 'QR_CODE',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('keeps server-visible unavailable offers and rejects inconsistent availability fields', () => {
    const projected = projectBillingCatalog({
      products: [
        {
          code: 'subscription',
          name: 'Subscription',
          kind: 'SUBSCRIPTION',
          level: 1,
          sortOrder: 1,
          offers: [
            {
              code: 'coming_soon',
              name: null,
              salesState: 'COMING_SOON',
              purchasable: false,
              unavailableReason: 'OFFER_COMING_SOON',
              interval: 'MONTH',
              currency: 'usd',
              amount: '9',
              minAmount: null,
              maxAmount: null,
              creditAmount: '100',
              rolloverCap: '0',
              purchaseOptions: [],
            },
            {
              code: 'no_available_channel',
              name: '',
              salesState: 'AVAILABLE',
              purchasable: false,
              unavailableReason: 'NO_AVAILABLE_PAYMENT_CHANNEL',
              interval: 'MONTH',
              currency: 'usd',
              amount: '19',
              minAmount: null,
              maxAmount: null,
              creditAmount: '250',
              rolloverCap: '0',
              purchaseOptions: [],
            },
            {
              code: 'available',
              name: 'x'.repeat(129),
              salesState: 'AVAILABLE',
              purchasable: true,
              unavailableReason: null,
              interval: 'MONTH',
              currency: 'usd',
              amount: '25',
              minAmount: null,
              maxAmount: null,
              creditAmount: '350',
              rolloverCap: '0',
              purchaseOptions: [
                {
                  id: 'listing_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
                  paymentAction: 'REDIRECT',
                },
              ],
            },
            {
              code: 'inconsistent',
              salesState: 'COMING_SOON',
              purchasable: true,
              unavailableReason: null,
              interval: 'MONTH',
              currency: 'usd',
              amount: '29',
              minAmount: null,
              maxAmount: null,
              creditAmount: '500',
              rolloverCap: '0',
              purchaseOptions: [],
            },
          ],
        },
      ],
    });

    expect(projected.products[0]?.offers).toEqual([
      expect.objectContaining({
        code: 'coming_soon',
        salesState: 'COMING_SOON',
        purchasable: false,
        unavailableReason: 'OFFER_COMING_SOON',
        purchaseOptions: [],
      }),
      expect.objectContaining({
        code: 'no_available_channel',
        salesState: 'AVAILABLE',
        purchasable: false,
        unavailableReason: 'NO_AVAILABLE_PAYMENT_CHANNEL',
        purchaseOptions: [],
      }),
      expect.objectContaining({
        code: 'available',
        salesState: 'AVAILABLE',
        purchasable: true,
        unavailableReason: null,
        purchaseOptions: [
          expect.objectContaining({
            id: 'listing_stripe',
            provider: 'stripe',
          }),
        ],
      }),
    ]);
    expect(projected.products[0]?.offers[0]).not.toHaveProperty('name');
    expect(projected.products[0]?.offers[1]).not.toHaveProperty('name');
    expect(projected.products[0]?.offers[2]).not.toHaveProperty('name');
  });

  it('enforces the server contract that offer codes are globally unique', () => {
    const purchaseOption = {
      id: 'listing_stripe',
      provider: 'stripe',
      capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
      paymentAction: 'REDIRECT',
    };
    const offer = (code: string) => ({
      code,
      interval: 'MONTH',
      currency: 'usd',
      amount: '10',
      minAmount: null,
      maxAmount: null,
      creditAmount: '100',
      rolloverCap: '0',
      purchaseOptions: [purchaseOption],
    });

    expect(
      projectBillingCatalog({
        products: [
          {
            code: 'plus',
            name: 'Plus',
            kind: 'SUBSCRIPTION',
            level: 1,
            sortOrder: 1,
            offers: [offer('shared_month')],
          },
          {
            code: 'max',
            name: 'Max',
            kind: 'SUBSCRIPTION',
            level: 2,
            sortOrder: 2,
            offers: [offer('shared_month'), offer('max_month')],
          },
        ],
      }),
    ).toMatchObject({
      products: [
        { code: 'plus', offers: [{ code: 'shared_month' }] },
        { code: 'max', offers: [{ code: 'max_month' }] },
      ],
    });
  });

  it('drops malformed list rows and strips unknown payment actions without leaking extra fields', () => {
    const projected = projectBillingOrderList({
      orders: [
        order(),
        order({ orderId: 'order_unknown_status', status: 'REFUNDING' }),
        order({
          orderId: 'order_unknown_action',
          paymentAction: {
            type: 'CUSTOM_SCHEME',
            value: 'javascript:alert(1)',
            expiresAt: now,
          },
        }),
        order({
          orderId: 'order_oversized_qr',
          paymentAction: {
            type: 'QR_CODE',
            value: 'x'.repeat(4_097),
            expiresAt: now,
          },
        }),
      ],
      nextCursor: null,
      serverDebug: 'hidden',
    });

    expect(projected.orders).toHaveLength(3);
    expect(projected.orders[0]).not.toHaveProperty('internalProviderResponse');
    expect(projected.orders[1]).toMatchObject({
      orderId: 'order_unknown_action',
      paymentAction: null,
    });
    expect(projected.orders[2]).toMatchObject({
      orderId: 'order_oversized_qr',
      paymentAction: null,
    });
  });

  it('rejects malformed single orders and fail-closes unknown subscription status', () => {
    expect(() => projectBillingPaymentOrder(order({ status: 'REFUNDING' }))).toThrow();
    expect(() =>
      projectBillingPaymentOrder(order({ createdAt: '2026-02-31T12:00:00.000Z' })),
    ).toThrow();
    expect(() =>
      projectBillingCurrentSubscription({
        subscription: {
          subscriptionId: 'subscription_1',
          status: 'FUTURE_STATUS',
          currentPeriodStartAt: null,
          currentPeriodEndAt: null,
          entitlementValidUntil: null,
          cancelAtPeriodEnd: false,
          effectivePlan: null,
          purchaseAttemptId: null,
          paymentAction: null,
        },
      }),
    ).toThrow();
  });

  it('strips provider identifiers and unsafe redirect actions from subscriptions', () => {
    const projected = projectBillingCurrentSubscription({
      subscription: {
        subscriptionId: 'subscription_1',
        status: 'ACTIVE',
        provider: 'future_provider',
        currentPeriodStartAt: now,
        currentPeriodEndAt: '2026-08-23T12:00:00.000Z',
        entitlementValidUntil: null,
        cancelAtPeriodEnd: false,
        effectivePlan: {
          version: 1,
          product: {
            id: 'internal_product_id',
            code: 'subscription_plus',
            kind: 'SUBSCRIPTION',
            level: 1,
          },
          offer: {
            id: 'internal_offer_id',
            code: 'subscription_plus_month',
            interval: 'MONTH',
          },
          provider: {
            id: 'internal_listing_id',
            provider: 'stripe',
            providerProductId: 'prod_fixture',
            providerPurchaseId: 'price_fixture',
          },
          terms: {
            amount: '20',
            currency: 'usd',
            creditAmount: '20',
            rolloverCap: '0',
          },
          capturedAt: now,
        },
        purchaseAttemptId: null,
        paymentAction: {
          type: 'REDIRECT',
          url: 'https://checkout.stripe.com.evil.example/pay',
          expiresAt: now,
        },
      },
    });

    expect(projected.subscription).not.toHaveProperty('provider');
    expect(projected.subscription?.paymentAction).toBeNull();
    expect(projected.subscription?.effectivePlan).toEqual({
      version: 1,
      product: { code: 'subscription_plus', kind: 'SUBSCRIPTION', level: 1 },
      offer: { code: 'subscription_plus_month', interval: 'MONTH' },
      terms: {
        amount: '20',
        currency: 'usd',
        creditAmount: '20',
        rolloverCap: '0',
      },
      capturedAt: now,
    });
  });

  it('accepts the provider-neutral Alipay subscription response without exposing mandate data', () => {
    const projected = projectBillingCurrentSubscription({
      subscription: {
        subscriptionId: 'subscription_1',
        status: 'INCOMPLETE',
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: false,
        effectivePlan: null,
        purchaseAttemptId: 'purchase_1',
        mandate: {
          mandateId: 'internal_mandate_1',
          status: 'PENDING',
          signedAt: null,
        },
        paymentAction: {
          type: 'QR_CODE',
          value: 'https://qr.alipay.example/session_fixture',
          expiresAt: now,
        },
      },
    });

    expect(projected.subscription).toMatchObject({
      subscriptionId: 'subscription_1',
      status: 'INCOMPLETE',
      paymentAction: {
        type: 'QR_CODE',
        value: 'https://qr.alipay.example/session_fixture',
        expiresAt: now,
      },
    });
    expect(projected.subscription).not.toHaveProperty('mandate');
  });

  it('passes resumable through when the server sends it and omits it otherwise', () => {
    const withResumable = projectBillingCurrentSubscription({
      subscription: {
        subscriptionId: 'subscription_1',
        status: 'ACTIVE',
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: true,
        resumable: true,
        effectivePlan: null,
        purchaseAttemptId: null,
        paymentAction: null,
      },
    });
    expect(withResumable.subscription).toMatchObject({ resumable: true });

    const withoutResumable = projectBillingCurrentSubscription({
      subscription: {
        subscriptionId: 'subscription_1',
        status: 'ACTIVE',
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: true,
        effectivePlan: null,
        purchaseAttemptId: null,
        paymentAction: null,
      },
    });
    expect(withoutResumable.subscription).not.toHaveProperty('resumable');
  });
});

describe('plan change projection', () => {
  const planChange = (overrides: Record<string, unknown> = {}) => ({
    planChangeId: 'plan_change_1',
    changeType: 'UPGRADE',
    status: 'AWAITING_PAYMENT',
    quotedAmountMinor: 1500,
    quotedCurrency: 'cny',
    quoteExpiresAt: now,
    effectiveAt: now,
    paymentAction: {
      type: 'QR_CODE',
      value: 'https://qr.alipay.example/pay',
      expiresAt: now,
    },
    providerChangeId: 'must not cross IPC',
    ...overrides,
  });

  const subscription = (overrides: Record<string, unknown> = {}) => ({
    subscriptionId: 'subscription_1',
    status: 'ACTIVE',
    provider: 'alipay',
    currentPeriodStartAt: null,
    currentPeriodEndAt: null,
    entitlementValidUntil: null,
    cancelAtPeriodEnd: false,
    effectivePlan: null,
    purchaseAttemptId: null,
    paymentAction: null,
    ...overrides,
  });

  it('projects a plan change and strips server-only fields', () => {
    expect(projectBillingPlanChange(planChange())).toEqual({
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'AWAITING_PAYMENT',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: now,
      effectiveAt: now,
      paymentAction: {
        type: 'QR_CODE',
        value: 'https://qr.alipay.example/pay',
        expiresAt: now,
      },
    });
  });

  it('accepts a Stripe Hosted Invoice redirect for an awaiting upgrade', () => {
    expect(projectBillingPlanChange(planChange({
      quotedCurrency: 'usd',
      paymentAction: {
        type: 'REDIRECT',
        url: 'https://invoice.stripe.com/i/acct_fixture/test_fixture',
        expiresAt: now,
      },
    }))).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentAction: {
        type: 'REDIRECT',
        url: 'https://invoice.stripe.com/i/acct_fixture/test_fixture',
      },
    });
  });

  it.each([
    ['unknown status', { status: 'FUTURE_STATUS' }],
    ['unknown change type', { changeType: 'SIDEGRADE' }],
    ['negative quoted amount', { quotedAmountMinor: -1 }],
    ['fractional quoted amount', { quotedAmountMinor: 10.5 }],
    ['missing effectiveAt', { effectiveAt: null }],
  ])('fail-closes a direct plan change response with %s', (_name, overrides) => {
    expect(() => projectBillingPlanChange(planChange(overrides))).toThrow(
      'invalid billing response',
    );
  });

  it('keeps a downgrade quote without amount or action', () => {
    expect(
      projectBillingPlanChange(
        planChange({
          changeType: 'DOWNGRADE',
          status: 'SCHEDULED',
          quotedAmountMinor: null,
          quotedCurrency: null,
          quoteExpiresAt: null,
          paymentAction: null,
        }),
      ),
    ).toMatchObject({ changeType: 'DOWNGRADE', status: 'SCHEDULED', quotedAmountMinor: null });
  });

  it('projects pendingPlanChange with the safe target plan subset', () => {
    const projected = projectBillingCurrentSubscription({
      subscription: subscription({
        pendingPlanChange: {
          ...planChange(),
          targetPlan: {
            product: { code: 'max', level: 300, internal: 'x' },
            offer: { code: 'max_month', interval: 'MONTH' },
            terms: { amount: '50', currency: 'cny', creditAmount: '50' },
          },
        },
      }),
    });
    expect(projected.subscription?.provider).toBe('alipay');
    expect(projected.subscription?.pendingPlanChange).toEqual({
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'AWAITING_PAYMENT',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: now,
      effectiveAt: now,
      paymentAction: {
        type: 'QR_CODE',
        value: 'https://qr.alipay.example/pay',
        expiresAt: now,
      },
      targetPlan: {
        product: { code: 'max', level: 300 },
        offer: { code: 'max_month', interval: 'MONTH' },
        terms: { amount: '50', currency: 'cny', creditAmount: '50' },
      },
    });
  });

  it('keeps pendingPlanChange null and distinguishes an omitted field', () => {
    const explicit = projectBillingCurrentSubscription({
      subscription: subscription({ pendingPlanChange: null }),
    });
    expect(explicit.subscription?.pendingPlanChange).toBeNull();

    const omitted = projectBillingCurrentSubscription({ subscription: subscription() });
    expect(omitted.subscription).not.toHaveProperty('pendingPlanChange');
  });

  it('drops an unknown pendingPlanChange instead of failing the subscription', () => {
    const projected = projectBillingCurrentSubscription({
      subscription: subscription({
        pendingPlanChange: { ...planChange({ status: 'FUTURE_STATUS' }), targetPlan: null },
      }),
    });
    expect(projected.subscription?.subscriptionId).toBe('subscription_1');
    expect(projected.subscription).not.toHaveProperty('pendingPlanChange');
  });

  it('degrades a malformed target plan to null without dropping the change', () => {
    const projected = projectBillingCurrentSubscription({
      subscription: subscription({
        pendingPlanChange: {
          ...planChange(),
          targetPlan: { product: { code: 'max' }, offer: {}, terms: {} },
        },
      }),
    });
    expect(projected.subscription?.pendingPlanChange).toMatchObject({ targetPlan: null });
  });
});
