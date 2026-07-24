// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listOrders: vi.fn(),
  getCurrentSubscription: vi.fn(),
  createTopup: vi.fn(),
  createSubscription: vi.fn(),
  retryTopup: vi.fn(),
  refreshTopup: vi.fn(),
  refreshSubscriptionPurchase: vi.fn(),
  getOrder: vi.fn(),
}));

vi.mock('../api', () => ({ billingApi: api }));

import {
  isRecoverableTopup,
  phaseForOrder,
  phaseForSubscription,
  useBillingCheckout,
} from '../useBillingCheckout';
import { readBillingCheckoutIntent, writeBillingCheckoutIntent } from '../checkoutIntent';

const ACCOUNT_ID = 'account-fixture';

describe('billing checkout phase projection', () => {
  beforeEach(() => {
    localStorage.clear();
    api.listOrders.mockReset().mockResolvedValue({ orders: [], nextCursor: null });
    api.getCurrentSubscription.mockReset().mockResolvedValue({ subscription: null });
    api.createTopup.mockReset();
    api.createSubscription.mockReset();
    api.retryTopup.mockReset();
    api.refreshTopup.mockReset();
    api.refreshSubscriptionPurchase.mockReset();
    api.getOrder.mockReset();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
  });

  it('keeps paid top-ups crediting until fulfillment succeeds', () => {
    const base = {
      orderId: 'order_fixture',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'SUCCEEDED' as const,
      paymentAction: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    expect(phaseForOrder(base)).toBe('FULFILLING');
    expect(phaseForOrder({ ...base, fulfillmentStatus: 'PENDING' })).toBe('FULFILLING');
    expect(phaseForOrder({ ...base, fulfillmentStatus: 'SUCCEEDED' })).toBe('COMPLETED');
    expect(phaseForOrder({ ...base, fulfillmentStatus: 'FAILED' })).toBe('FULFILLING');
  });

  it('shows active subscriptions as paid without exposing entitlement state', () => {
    const base = {
      subscriptionId: 'subscription_fixture',
      status: 'ACTIVE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: null,
      paymentAction: null,
    };
    expect(phaseForSubscription(base)).toBe('COMPLETED');
    expect(phaseForSubscription({ ...base, entitlementStatus: 'SUCCEEDED' })).toBe('COMPLETED');
    expect(phaseForSubscription({ ...base, entitlementStatus: 'FAILED' })).toBe('COMPLETED');
  });

  it('lets the server confirm expiry instead of trusting the client clock', () => {
    expect(
      isRecoverableTopup({
        status: 'PENDING',
        paymentAction: {
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  it('keeps created top-ups with a payment action recoverable', () => {
    expect(
      isRecoverableTopup({
        status: 'CREATED',
        paymentAction: {
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  it('keeps pending top-ups recoverable before a payment action is projected', () => {
    expect(
      isRecoverableTopup({
        status: 'CREATED',
        paymentAction: null,
      }),
    ).toBe(true);
    expect(
      isRecoverableTopup({
        status: 'PENDING',
        paymentAction: null,
      }),
    ).toBe(true);
  });

  it('keeps paid but unfulfilled top-ups recoverable without a payment action', () => {
    expect(
      isRecoverableTopup({
        status: 'SUCCEEDED',
        fulfillmentStatus: 'PENDING',
        paymentAction: null,
      }),
    ).toBe(true);
    expect(
      isRecoverableTopup({
        status: 'SUCCEEDED',
        fulfillmentStatus: 'SUCCEEDED',
        paymentAction: null,
      }),
    ).toBe(false);
  });

  it('keeps the checkout intent until paid top-up fulfillment succeeds', async () => {
    const paidOrder = {
      orderId: 'order_paid',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'SUCCEEDED' as const,
      fulfillmentStatus: 'PENDING' as const,
      paymentAction: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    api.createTopup.mockResolvedValue(paidOrder);
    api.getOrder.mockResolvedValue({
      ...paidOrder,
      fulfillmentStatus: 'SUCCEEDED',
    });
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    await act(() =>
      result.current.startTopup({
        offerCode: 'credit_topup_20',
        purchaseOptionId: 'listing_alipay',
      }),
    );

    expect(result.current.state.phase).toBe('FULFILLING');
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).not.toBeNull();

    await act(() => result.current.refreshActive());

    expect(api.getOrder).toHaveBeenCalledWith('order_paid');
    expect(result.current.state.phase).toBe('COMPLETED');
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toBeNull();
  });

  it('replays an unresolved persisted purchase with the original request and key', async () => {
    const pending = {
      subscriptionId: 'subscription_pending',
      status: 'INCOMPLETE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: 'purchase_pending',
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'alipays://pending',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    };
    api.createSubscription.mockResolvedValue(pending);
    writeBillingCheckoutIntent(ACCOUNT_ID, {
      version: 1,
      kind: 'SUBSCRIPTION',
      idempotencyKey: 'desktop:subscription:stale-intent',
      request: {
        offerCode: 'retired_plus_month',
        purchaseOptionId: 'listing_alipay',
      },
      subscriptionId: null,
      purchaseAttemptId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    expect(api.listOrders).toHaveBeenCalledTimes(1);
    expect(api.getCurrentSubscription).toHaveBeenCalledTimes(1);
    expect(api.createTopup).not.toHaveBeenCalled();
    expect(api.createSubscription).toHaveBeenCalledWith(
      {
        offerCode: 'retired_plus_month',
        purchaseOptionId: 'listing_alipay',
      },
      'desktop:subscription:stale-intent',
    );
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toEqual({
      version: 1,
      kind: 'SUBSCRIPTION',
      idempotencyKey: 'desktop:subscription:stale-intent',
      request: {
        offerCode: 'retired_plus_month',
        purchaseOptionId: 'listing_alipay',
      },
      subscriptionId: 'subscription_pending',
      purchaseAttemptId: 'purchase_pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('does not replace a persisted subscription intent with another current subscription', async () => {
    const intent = {
      version: 1 as const,
      kind: 'SUBSCRIPTION' as const,
      idempotencyKey: 'desktop:subscription:pending-intent',
      request: {
        offerCode: 'plus_month',
        purchaseOptionId: 'listing_alipay',
      },
      subscriptionId: 'subscription_expected',
      purchaseAttemptId: 'purchase_expected',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const unrelated = {
      subscriptionId: 'subscription_other',
      status: 'ACTIVE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: 'purchase_other',
      paymentAction: null,
    };
    writeBillingCheckoutIntent(ACCOUNT_ID, intent);
    api.getCurrentSubscription.mockResolvedValue({ subscription: unrelated });
    api.refreshSubscriptionPurchase.mockResolvedValue(unrelated);

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    expect(api.refreshSubscriptionPurchase).toHaveBeenCalledWith('purchase_expected');
    expect(result.current.state).toMatchObject({
      phase: 'FAILED',
      intent,
      subscription: null,
      error: true,
    });
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toEqual(intent);
  });

  it('accepts a terminal same-subscription result after its purchase attempt is cleared', async () => {
    const intent = {
      version: 1 as const,
      kind: 'SUBSCRIPTION' as const,
      idempotencyKey: 'desktop:subscription:completed-intent',
      request: {
        offerCode: 'plus_month',
        purchaseOptionId: 'listing_alipay',
      },
      subscriptionId: 'subscription_expected',
      purchaseAttemptId: 'purchase_expected',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const completed = {
      subscriptionId: 'subscription_expected',
      status: 'ACTIVE' as const,
      currentPeriodStartAt: '2026-01-01T00:00:00.000Z',
      currentPeriodEndAt: '2026-02-01T00:00:00.000Z',
      entitlementValidUntil: '2026-02-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: null,
      paymentAction: null,
    };
    writeBillingCheckoutIntent(ACCOUNT_ID, intent);
    api.getCurrentSubscription.mockResolvedValue({ subscription: completed });
    api.refreshSubscriptionPurchase.mockResolvedValue(completed);

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    expect(api.refreshSubscriptionPurchase).toHaveBeenCalledWith('purchase_expected');
    expect(result.current.state).toMatchObject({
      phase: 'COMPLETED',
      subscription: completed,
      error: false,
    });
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toBeNull();
  });

  it('keeps an unresolved persisted purchase retryable when recovery fails', async () => {
    const intent = {
      version: 1 as const,
      kind: 'TOPUP' as const,
      idempotencyKey: 'desktop:topup:unresolved-intent',
      request: {
        offerCode: 'credit_topup_custom',
        amount: '20',
        purchaseOptionId: 'listing_alipay',
      },
      orderId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeBillingCheckoutIntent(ACCOUNT_ID, intent);
    api.createTopup.mockRejectedValue(new Error('network result unknown'));

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    expect(result.current.state).toMatchObject({
      open: true,
      kind: 'TOPUP',
      phase: 'FAILED',
      intent,
      error: true,
    });
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toEqual(intent);
    act(() => result.current.close());
    expect(result.current.state.open).toBe(false);
    expect(readBillingCheckoutIntent(ACCOUNT_ID)).toEqual(intent);
  });

  it('does not bind an unidentified intent to another pending subscription', async () => {
    const unrelated = {
      subscriptionId: 'subscription_other',
      status: 'INCOMPLETE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: 'purchase_other',
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'alipays://pending',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    };
    api.createSubscription.mockRejectedValue(new Error('SUBSCRIPTION_NOT_MANAGEABLE'));
    api.getCurrentSubscription
      .mockResolvedValueOnce({ subscription: null })
      .mockResolvedValueOnce({ subscription: unrelated });

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    await act(async () =>
      result.current.startSubscription({
        offerCode: 'plus_month',
        purchaseOptionId: 'listing_alipay',
      }),
    );

    expect(api.getCurrentSubscription).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      phase: 'FAILED',
      subscription: null,
      error: true,
    });
    expect(result.current.state.intent).toMatchObject({
      subscriptionId: null,
      purchaseAttemptId: null,
    });
  });

  it('reuses the same retry key while the retry result is unknown', async () => {
    const failedOrder = {
      orderId: 'order_fixture',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'FAILED' as const,
      paymentAction: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    api.retryTopup.mockRejectedValue(new Error('network result unknown'));

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    act(() => result.current.resumeTopup(failedOrder));
    await act(async () => result.current.retry());
    await act(async () => result.current.retry());

    expect(api.retryTopup).toHaveBeenCalledTimes(2);
    expect(api.retryTopup.mock.calls[0]).toEqual(api.retryTopup.mock.calls[1]);
    expect(api.retryTopup.mock.calls[0]).toEqual([
      'order_fixture',
      'desktop:retry:00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('refreshes on focus without allowing concurrent status requests', async () => {
    const pendingOrder = {
      orderId: 'order_fixture',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'PENDING' as const,
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'https://pay.example.test/checkout/fixture',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    let resolveRefresh: ((value: typeof pendingOrder) => void) | null = null;
    api.refreshTopup.mockImplementation(
      () =>
        new Promise<typeof pendingOrder>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));
    act(() => result.current.resumeTopup(pendingOrder));
    await waitFor(() => expect(result.current.state.phase).toBe('AWAITING_PAYMENT'));

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.refreshTopup).toHaveBeenCalledTimes(1));

    await act(async () => resolveRefresh?.(pendingOrder));
    expect(api.refreshTopup).toHaveBeenCalledWith('order_fixture');
  });

  it('keeps a pending checkout recoverable after its dialog is closed', async () => {
    const pendingOrder = {
      orderId: 'order_pending',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'PENDING' as const,
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'https://pay.example.test/checkout/pending',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };

    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.recovering).toBe(false));

    act(() => result.current.resumeTopup(pendingOrder));
    act(() => result.current.close());

    expect(result.current.state.open).toBe(false);
    expect(result.current.recoverables.topups).toEqual([pendingOrder]);

    act(() => result.current.resumeTopup(result.current.recoverables.topups[0]));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.order).toEqual(pendingOrder);
  });
});
