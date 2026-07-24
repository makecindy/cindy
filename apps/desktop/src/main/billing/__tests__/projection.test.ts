import { describe, expect, it } from 'vitest';

import {
  projectBillingCatalog,
  projectBillingCurrentSubscription,
  projectBillingOrderList,
  projectBillingPaymentOrder,
  projectModelAccessBalance,
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
        managementAction: 'FUTURE_ACTION',
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
    expect(projected.subscription).not.toHaveProperty('managementAction');
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
});
