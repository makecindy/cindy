import { describe, expect, it } from 'vitest';
import { BILLING_CURRENCY } from '../../../shared/billingCurrency.js';

import {
  projectBillingCatalog,
  projectBillingCurrentSubscription,
  projectBillingOrderList,
  projectBillingPaymentHistory,
  projectBillingPaymentOrder,
  projectBillingPlanChange,
  projectGiftCardPurchasePolicy,
  projectModelAccessBalance,
  projectModelAccessCreditUsage,
  projectPurchasedGiftCardCode,
  isPurchasedGiftCardCursor,
  isPurchasedGiftCardId,
  projectPurchasedGiftCardList,
} from '../projection.js';

const now = '2026-07-23T12:00:00.000Z';

function historyRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordId: 'SUBSCRIPTION_INVOICE:invoice_1', sourceType: 'SUBSCRIPTION_INVOICE', sourceId: 'invoice_1',
    subscriptionId: 'ended-subscription', productName: 'Plus', billingReason: 'subscription_cycle',
    amountPaidMinor: 1100, amount: '11.00', currency: 'usd', provider: 'stripe', providerTransactionId: 'pi_fixture',
    paidAt: now, createdAt: now, periodStartAt: now, periodEndAt: '2026-08-23T12:00:00.000Z',
    refundSummary: { status: 'PARTIALLY_REFUNDED', refundedMinor: 100, refundedAmount: '1.00' },
    ...overrides,
  };
}

describe('paid history projection', () => {
  it('projects settled invoice data and removes private provider fields', () => {
    const record = historyRecord({ quantity: 1 });
    expect(projectBillingPaymentHistory({ records: [{ ...record, providerSnapshot: { private: true } }], nextCursor: 'next_page' }))
      .toEqual({ records: [record], nextCursor: 'next_page' });
  });

  it('preserves legacy unknown amounts and payment times', () => {
    // 旧服务端不下发张数：那时只有充值和订阅账单，各按一笔展示。
    const record = historyRecord({
      amountPaidMinor: null, amount: null, paidAt: null, productName: null,
      refundSummary: { status: null, refundedMinor: 100, refundedAmount: '1.00' },
    });
    expect(projectBillingPaymentHistory({ records: [record], nextCursor: null }).records)
      .toEqual([{ ...record, quantity: 1 }]);
  });

  // 带 includeGiftCards 的新服务端会混入礼品卡订单；张数缺失就说不清这笔买了几张，整页按异常处理。
  it('keeps gift card orders with their card count and refuses one without a count', () => {
    const giftCard = historyRecord({
      recordId: 'GIFT_CARD:order_9', sourceType: 'GIFT_CARD', sourceId: 'order_9', subscriptionId: null,
      billingReason: null, periodStartAt: null, periodEndAt: null, quantity: 2,
    });
    expect(projectBillingPaymentHistory({ records: [giftCard], nextCursor: null }).records[0])
      .toMatchObject({ sourceType: 'GIFT_CARD', quantity: 2 });
    expect(() => projectBillingPaymentHistory({
      records: [{ ...giftCard, quantity: undefined }], nextCursor: null,
    })).toThrow();
  });

  it('accepts older history responses without a transaction reference', () => {
    const record = historyRecord({ providerTransactionId: undefined });
    expect(projectBillingPaymentHistory({ records: [record], nextCursor: null }).records[0])
      .toMatchObject({ providerTransactionId: null });
  });

  it.each([
    { sourceType: 'UNKNOWN' }, { recordId: 'different-record' }, { paidAt: 'yesterday' },
    { amount: null }, { amountPaidMinor: -1 }, { providerTransactionId: 123 }, { providerTransactionId: 'x'.repeat(256) },
    { refundSummary: { status: 'REFUNDED', refundedMinor: -1, refundedAmount: '0' } },
  ])('fails the entire page rather than silently dropping a malformed paid record: %j', (overrides) => {
    expect(() => projectBillingPaymentHistory({ records: [historyRecord(), historyRecord(overrides)], nextCursor: null })).toThrow();
  });

  it('rejects unbounded cursors at the main-process boundary', () => {
    expect(() => projectBillingPaymentHistory({ records: [], nextCursor: 'x'.repeat(1025) })).toThrow();
  });
});

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

  // D17: the real credit-usage projector must retain nullable source for localized
  // rollover names; its old allowlist dropped the field before renderer received it (unit).
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
            source: { type: 'subscription_rollover' },
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
            source: null,
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
          source: { type: 'subscription_rollover' },
          originalAmount: '2',
          usedAmount: '1',
          remainingAmount: '1',
          expiresAt: '2026-08-01T00:00:00.123456789Z',
          state: 'active',
        },
        {
          grantId: 'expired',
          displayName: null,
          source: null,
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

  // 人工审查后的来源契约（unit）：同一真实投影接受滚存/礼品卡对象和 null，
  // 旧覆盖只验证字符串滚存；最小失败输入是滚存对象，以及必须忽略的旧字符串。
  it('keeps rollover and gift card objects while dropping string and malformed sources', () => {
    const grant = (grantId: string, source: unknown) => ({
      grantId,
      displayName: null,
      originalAmount: '1',
      usedAmount: '0',
      remainingAmount: '1',
      expiresAt: '2026-08-01T00:00:00Z',
      state: 'active',
      ...(source === undefined ? {} : { source }),
    });
    const sources: unknown[] = [
      { type: 'gift_card', senderName: 'Cindy Team', cardId: 'internal' },
      undefined,
      null,
      { type: 'coupon', senderName: 'Someone' },
      { type: 'gift_card', senderName: '' },
      { type: 'gift_card', senderName: 'x'.repeat(81) },
      { type: 'gift_card' },
      'gift_card',
      'subscription_rollover',
      { type: 'subscription_rollover', cardId: 'internal' },
      'x'.repeat(4096),
    ];
    const usage = projectModelAccessCreditUsage({
      available: String(sources.length),
      plan: { remaining: '0', used: '0', total: '0' },
      purchased: { remaining: '0', used: '0', total: '0' },
      promotional: { remaining: String(sources.length), used: '0', total: String(sources.length) },
      promotionalGrants: sources.map((source, index) => grant(`grant-${index}`, source)),
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED',
      ledgerUpdatedAt: null,
      scale: 9,
      observedAt: '2026-07-23T12:00:00Z',
    });

    expect(usage.promotionalGrants[0].source).toEqual({ type: 'gift_card', senderName: 'Cindy Team' });
    expect(usage.promotionalGrants[2].source).toBeNull();
    expect(usage.promotionalGrants[9].source).toEqual({ type: 'subscription_rollover' });
    for (const projected of [
      usage.promotionalGrants[1],
      ...usage.promotionalGrants.slice(3, 9),
      usage.promotionalGrants[10],
    ]) {
      expect(projected).not.toHaveProperty('source');
    }
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

describe('gift card purchase projection', () => {
  const giftCardProduct = (offers: unknown[]) => ({
    code: 'gift_card', name: 'Cindy 礼品卡', kind: 'GIFT_CARD', level: null, sortOrder: 3, offers,
  });
  const giftOffer = (overrides: Record<string, unknown> = {}) => ({
    code: 'gift_card_100', name: null, interval: null, currency: 'cny', amount: '100',
    minAmount: null, maxAmount: null, creditAmount: '100', rolloverCap: null,
    salesState: 'AVAILABLE', purchasable: true, unavailableReason: null,
    purchaseOptions: [{ id: 'listing_alipay', provider: 'alipay', capability: 'ONE_TIME_PAYMENT', paymentAction: 'QR_CODE' }],
    ...overrides,
  });

  // 面额印在卡面上：固定面额的到账金额必须等于面额；买家自填面额只带范围，到账随所填面额，
  // 带了固定到账额度的「自填」方案对不上卡面，不能拿来卖。
  it('keeps fixed and buyer-entered gift card amounts and drops offers whose credit differs from the face value', () => {
    const catalog = projectBillingCatalog({
      products: [giftCardProduct([
        giftOffer(),
        // 同一个金额写法不同（小数位数不同）仍是同一个面额。
        giftOffer({ code: 'gift_card_200', amount: '200', creditAmount: '200.000000000' }),
        giftOffer({ code: 'gift_card_odd', creditAmount: '120' }),
        giftOffer({ code: 'gift_card_custom', amount: null, creditAmount: null, minAmount: '100', maxAmount: '500' }),
        giftOffer({ code: 'gift_card_custom_odd', amount: null, creditAmount: '100', minAmount: '100', maxAmount: '500' }),
        // 面额精度是分：去掉末尾 0 后仍超过两位小数的面额或范围对不上卡面，界面也无法按分校验，不卖。
        giftOffer({ code: 'gift_card_sub_cent', amount: '20.001', creditAmount: '20.001' }),
        giftOffer({ code: 'gift_card_custom_sub_cent', amount: null, creditAmount: null, minAmount: '1.005', maxAmount: '500' }),
        giftOffer({ code: 'gift_card_custom_long', amount: null, creditAmount: null, minAmount: '100.500000000', maxAmount: '500' }),
        // 整数部分超过 12 位的面额界面无法按分换算，不卖。
        giftOffer({ code: 'gift_card_huge', amount: '1234567890123', creditAmount: '1234567890123' }),
        // 0 元的面额不能卖。
        giftOffer({ code: 'gift_card_zero', amount: '0', creditAmount: '0.00' }),
        giftOffer({ code: 'gift_card_custom_zero', amount: null, creditAmount: null, minAmount: '0', maxAmount: '500' }),
      ])],
    });
    expect(catalog.products).toHaveLength(1);
    expect(catalog.products[0]).toMatchObject({ kind: 'GIFT_CARD', level: null });
    expect(catalog.products[0]!.offers.map((offer) => offer.code))
      .toEqual(['gift_card_100', 'gift_card_200', 'gift_card_custom', 'gift_card_custom_long']);
    expect(catalog.products[0]!.offers[2]).toMatchObject({ amount: null, minAmount: '100', maxAmount: '500' });
    expect(catalog.products[0]!.offers[0]!.purchaseOptions[0]).toMatchObject({ capability: 'ONE_TIME_PAYMENT' });
  });

  it('carries the product kind and card count on orders and fails closed on an unknown kind', () => {
    const giftOrder = (overrides: Record<string, unknown> = {}) =>
      order({ productKind: 'GIFT_CARD', quantity: 3, currency: BILLING_CURRENCY, ...overrides });
    expect(projectBillingPaymentOrder(giftOrder()))
      .toMatchObject({ productKind: 'GIFT_CARD', quantity: 3 });
    expect(projectBillingPaymentOrder(order())).not.toHaveProperty('productKind');
    expect(() => projectBillingPaymentOrder(order({ productKind: 'VOUCHER' }))).toThrow();
    expect(() => projectBillingPaymentOrder(giftOrder({ quantity: 0 }))).toThrow();
    // 礼品卡订单缺张数不能当成一张；币种必须是本区域余额币种，不能按本币说外币的价。
    expect(() => projectBillingPaymentOrder(giftOrder({ quantity: undefined }))).toThrow();
    expect(() => projectBillingPaymentOrder(giftOrder({ currency: BILLING_CURRENCY === 'usd' ? 'eur' : 'usd' }))).toThrow();
  });

  it('reads the purchase limits with the gift card currency casing and never offers more than the window allows', () => {
    expect(projectGiftCardPurchasePolicy({
      currency: 'CNY', dailyLimit: 5, windowHours: 24, remaining: 9, maxQuantityPerOrder: 5,
      maxOrderAmount: '1000', minFaceValue: '100', maxFaceValue: '1000',
      faces: ['cindy', 'cat', '../x'], maxSenderNameLength: 40, maxMessageLength: 120,
    })).toEqual({
      currency: 'cny', dailyLimit: 5, windowHours: 24, remaining: 5, maxQuantityPerOrder: 5,
      maxOrderAmount: '1000', minFaceValue: '100', maxFaceValue: '1000',
      faces: ['cindy', 'cat'], maxSenderNameLength: 40, maxMessageLength: 120, emailCooldownSeconds: null,
    });
    // 旧服务端没有单张面额范围：照常读出其余限制，范围为 null。
    expect(projectGiftCardPurchasePolicy({
      currency: 'CNY', dailyLimit: 5, windowHours: 24, remaining: 5, maxQuantityPerOrder: 5,
      maxOrderAmount: '1000', faces: ['cindy'], maxSenderNameLength: 40, maxMessageLength: 120,
    })).toMatchObject({ minFaceValue: null, maxFaceValue: null, emailCooldownSeconds: null });
    expect(projectGiftCardPurchasePolicy({
      currency: 'CNY', dailyLimit: 5, windowHours: 24, remaining: 5, maxQuantityPerOrder: 5,
      maxOrderAmount: '1000', emailCooldownSeconds: 60, faces: ['cindy'], maxSenderNameLength: 40, maxMessageLength: 120,
    })).toMatchObject({ emailCooldownSeconds: 60 });
    expect(() => projectGiftCardPurchasePolicy({ currency: 'USD', dailyLimit: 5 })).toThrow();
    // 新服务端给了面额范围或发信冷却却不合法：按坏响应处理，不当成旧服务端（否则自填面额只按价格方案
    // 范围校验，下单才被拒）。服务端明确给 null（本区域不支持礼品卡）照常读出。
    const base = {
      currency: 'CNY', dailyLimit: 5, windowHours: 24, remaining: 5, maxQuantityPerOrder: 5,
      maxOrderAmount: '1000', faces: ['cindy'], maxSenderNameLength: 40, maxMessageLength: 120,
    };
    for (const malformed of [
      { minFaceValue: 'abc' }, { maxFaceValue: 100 }, { minFaceValue: '1.005' }, { maxOrderAmount: '1000.001' },
      { maxOrderAmount: '1234567890123' }, { maxOrderAmount: '0' }, { minFaceValue: '0.00' },
      { emailCooldownSeconds: -1 }, { emailCooldownSeconds: 1.5 },
    ]) {
      expect(() => projectGiftCardPurchasePolicy({ ...base, ...malformed })).toThrow();
    }
    // 只是小数位写得更长的上限照常读出。
    expect(projectGiftCardPurchasePolicy({ ...base, maxOrderAmount: '1000.000000000' })).toMatchObject({ maxOrderAmount: '1000.000000000' });
    // 冷却 0 秒是合法的「不冷却」，不能当成不支持发信，更不能让整份购买设置读取失败。
    expect(projectGiftCardPurchasePolicy({ ...base, emailCooldownSeconds: 0 })).toMatchObject({ emailCooldownSeconds: 0 });
    expect(projectGiftCardPurchasePolicy({ ...base, minFaceValue: null, maxFaceValue: null }))
      .toMatchObject({ minFaceValue: null, maxFaceValue: null });
  });

  const purchasedCard = (overrides: Record<string, unknown> = {}) => ({
    cardId: 'card_1', orderId: 'order_9', faceCode: 'cat', amount: '100', currency: BILLING_CURRENCY.toUpperCase(),
    senderName: '小鱼', message: null, codeTail: '7KQ2', status: 'UNCLAIMED',
    claimedAt: null, claimedByName: null, purchasedAt: now, ...overrides,
  });

  // 领取人昵称只属于「被别人领走」；其它状态即使服务端带了也不展示。
  it('shows the claimer name only for cards someone else claimed', () => {
    const list = projectPurchasedGiftCardList({
      cards: [
        purchasedCard({ status: 'CLAIMED', claimedAt: now, claimedByName: '阿杰' }),
        purchasedCard({ cardId: 'card_2', status: 'REDEEMED_BY_YOU', claimedAt: now, claimedByName: '小鱼' }),
        purchasedCard({ cardId: 'card_1' }),
      ],
      nextCursor: 'next.page_1',
    });
    expect(list.cards.map((card) => [card.cardId, card.claimedByName, card.currency])).toEqual([
      ['card_1', '阿杰', BILLING_CURRENCY],
      ['card_2', null, BILLING_CURRENCY],
    ]);
    expect(list.nextCursor).toBe('next.page_1');
    // 读进来的游标要能原样发回「加载更多」（与 IPC 参数校验同一条规则）；服务端发的是 base64url。
    expect(isPurchasedGiftCardCursor(list.nextCursor)).toBe(true);
    for (const cursor of ['abc=', 'a/b', 'x'.repeat(513), '']) {
      expect(() => projectPurchasedGiftCardList({ cards: [], nextCursor: cursor })).toThrow();
      expect(isPurchasedGiftCardCursor(cursor)).toBe(false);
    }
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ status: 'SOLD' })], nextCursor: null })).toThrow();
    // 面额印在卡面上：比分更细的金额按坏响应处理；只是小数位写得更长的照常读出。
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ amount: '1.005' })], nextCursor: null })).toThrow();
    // 卡按本区域余额币种发与入账，兑换时也按它展示：其它币种的卡按坏响应处理，不在列表与兑换之间换币种。
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ currency: 'EUR' })], nextCursor: null })).toThrow();
    // 整数部分最多 12 位，与购买弹窗按分换算、下单请求的面额校验同一范围。
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ amount: '1234567890123' })], nextCursor: null })).toThrow();
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ amount: '0' })], nextCursor: null })).toThrow();
    // 读进来的卡号一定能用来取码和发信（与两个 IPC 请求同一条规则）；不是卡号的按坏响应处理。
    expect(isPurchasedGiftCardId('card_1') && isPurchasedGiftCardId('3f2b8c1e-0a4d-4c55-9f1e-2b7d9c0e6a11')).toBe(true);
    expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ cardId: '../card_1' })], nextCursor: null })).toThrow();
    expect(projectPurchasedGiftCardList({ cards: [purchasedCard({ amount: '100.500000000' })], nextCursor: null })
      .cards.map((card) => card.amount)).toEqual(['100.500000000']);
    // 退款或拒付还在处理的卡（ON_HOLD）照常读出。
    expect(projectPurchasedGiftCardList({ cards: [purchasedCard({ status: 'ON_HOLD' })], nextCursor: null })
      .cards.map((card) => card.status)).toEqual(['ON_HOLD']);
  });

  // 支持发信的服务端每张卡都带 email 字段（没发过为 null），旧服务端没有这个字段时界面不提供
  // 「发送到邮箱」；新服务端给了却不合法时按坏响应处理，不悄悄当成没发过。
  it('reads the email delivery, tells whether the server can send by email, and rejects a malformed one', () => {
    const email = {
      recipient: 'friend@example.com', status: 'SENT',
      updatedAt: '2026-11-19T08:05:00.000Z', nextAvailableAt: '2026-11-19T08:06:00.000Z',
    };
    const list = projectPurchasedGiftCardList({
      cards: [
        purchasedCard({ email }),
        purchasedCard({ cardId: 'card_4', email: null }),
      ],
      nextCursor: null,
    });
    expect(list.cards.map((card) => card.email?.status ?? null)).toEqual(['SENT', null]);
    expect(list.emailSupported).toBe(true);
    for (const malformed of [{ ...email, status: 'BOUNCED' }, { ...email, nextAvailableAt: 'soon' }, 'sent']) {
      expect(() => projectPurchasedGiftCardList({ cards: [purchasedCard({ email: malformed })], nextCursor: null }))
        .toThrow();
    }
    expect(projectPurchasedGiftCardList({ cards: [purchasedCard()], nextCursor: null }))
      .toMatchObject({ emailSupported: false, cards: [{ email: null }] });
    expect(projectPurchasedGiftCardList({ cards: [], nextCursor: null }).emailSupported).toBe(false);
  });

  it('accepts only a well-formed redeem code and returns it in display form', () => {
    expect(projectPurchasedGiftCardCode({ code: 'c012-3456-789a-bcde' })).toEqual({ code: 'C012-3456-789A-BCDE' });
    expect(() => projectPurchasedGiftCardCode({ code: 'C012-3456' })).toThrow();
  });
});
