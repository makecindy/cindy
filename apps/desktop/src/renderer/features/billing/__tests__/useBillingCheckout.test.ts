// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { phaseForOrder, phaseForSubscription, useBillingCheckout } from '../useBillingCheckout';

const ACCOUNT_ID = 'account-fixture';

function pendingOrder(orderId = 'order_pending') {
  return {
    orderId,
    productCode: 'credit_topup',
    offerCode: 'credit_topup_20',
    amount: '20',
    currency: 'cny',
    status: 'PENDING' as const,
    paymentAction: {
      type: 'QR_CODE' as const,
      value: 'https://qr.example/1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
}

describe('billing checkout phase projection', () => {
  it('treats successful top-ups as completed regardless of fulfillment projection', () => {
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
    expect(phaseForOrder(base)).toBe('COMPLETED');
    expect(phaseForOrder({ ...base, fulfillmentStatus: 'PENDING' })).toBe('COMPLETED');
    expect(phaseForOrder({ ...base, fulfillmentStatus: 'FAILED' })).toBe('COMPLETED');
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
    expect(phaseForSubscription({ ...base, entitlementStatus: 'FAILED' })).toBe('COMPLETED');
  });
});

describe('useBillingCheckout ephemeral sessions', () => {
  let uuidCounter = 0;

  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(api)) mock.mockReset();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    uuidCounter = 0;
    vi.stubGlobal('crypto', {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call any billing API on startup and never restores past checkouts', async () => {
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(result.current.state.phase).toBe('IDLE'));
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(api.getCurrentSubscription).not.toHaveBeenCalled();
    expect(api.getOrder).not.toHaveBeenCalled();
    expect(result.current.state.open).toBe(false);
  });

  it('clears legacy persisted intents without replaying them', async () => {
    const legacyKey = `cindy.billing.checkout-intent.v2:${encodeURIComponent(ACCOUNT_ID)}`;
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        kind: 'TOPUP',
        idempotencyKey: 'desktop:topup:legacy',
        request: { offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' },
        orderId: 'order_legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    localStorage.setItem(
      `cindy.billing.plan-change-intent.v1:${encodeURIComponent(ACCOUNT_ID)}`,
      JSON.stringify({ version: 1 }),
    );
    renderHook(() => useBillingCheckout(ACCOUNT_ID));
    await waitFor(() => expect(localStorage.getItem(legacyKey)).toBeNull());
    expect(
      localStorage.getItem(`cindy.billing.plan-change-intent.v1:${encodeURIComponent(ACCOUNT_ID)}`),
    ).toBeNull();
    expect(api.createTopup).not.toHaveBeenCalled();
    expect(api.retryTopup).not.toHaveBeenCalled();
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it('sends a fresh idempotency key after the dialog is closed and reopened', async () => {
    api.createTopup.mockResolvedValue(pendingOrder());
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));
    const request = { offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' };

    await act(() => result.current.startTopup(request));
    const firstKey = api.createTopup.mock.calls[0][1] as string;

    act(() => result.current.close());
    expect(result.current.state.phase).toBe('IDLE');
    expect(result.current.state.order).toBeNull();

    await act(() => result.current.startTopup(request));
    const secondKey = api.createTopup.mock.calls[1][1] as string;
    expect(secondKey).not.toBe(firstKey);
  });

  it('keeps polling the open session and completes when the server reports success', async () => {
    const order = pendingOrder();
    api.createTopup.mockResolvedValue(order);
    api.refreshTopup.mockResolvedValue({ ...order, status: 'SUCCEEDED', paymentAction: null });
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');

    await act(() => result.current.refreshActive());
    expect(api.refreshTopup).toHaveBeenCalledWith(order.orderId);
    expect(result.current.state.phase).toBe('COMPLETED');
  });

  it('lets an expired session end and a new selection start over with a new key', async () => {
    const order = pendingOrder();
    api.createTopup.mockResolvedValueOnce(order);
    api.refreshTopup.mockResolvedValue({ ...order, status: 'EXPIRED', paymentAction: null });
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    await act(() => result.current.refreshActive());
    expect(result.current.state.phase).toBe('EXPIRED');

    api.createTopup.mockResolvedValueOnce(pendingOrder('order_next'));
    act(() => result.current.close());
    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    expect(result.current.state.order?.orderId).toBe('order_next');
    const keys = api.createTopup.mock.calls.map((call) => call[1]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('creates a subscription session and polls it through the purchase attempt only', async () => {
    const incomplete = {
      subscriptionId: 'subscription_1',
      status: 'INCOMPLETE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: 'attempt_1',
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'https://qr.example/sub',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    };
    api.createSubscription.mockResolvedValue(incomplete);
    api.refreshSubscriptionPurchase.mockResolvedValue({
      ...incomplete,
      status: 'ACTIVE' as const,
      paymentAction: null,
    });
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startSubscription({ offerCode: 'pro_monthly', purchaseOptionId: 'option_1' }),
    );
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');

    await act(() => result.current.refreshActive());
    expect(api.refreshSubscriptionPurchase).toHaveBeenCalledWith('attempt_1');
    expect(api.getCurrentSubscription).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('COMPLETED');
  });

  it('marks the session failed when create errors and replays the same key on retry', async () => {
    api.createTopup.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    expect(result.current.state.phase).toBe('FAILED');
    expect(result.current.state.error).toBe(true);

    api.createTopup.mockResolvedValueOnce(pendingOrder());
    await act(() => result.current.retry());
    expect(api.createTopup.mock.calls[1][1]).toBe(api.createTopup.mock.calls[0][1]);
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');
  });

  it('ignores in-flight responses after the dialog is closed instead of reopening it', async () => {
    let release!: (value: unknown) => void;
    api.createTopup.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    let started!: Promise<void>;
    act(() => {
      started = result.current.startTopup({
        offerCode: 'credit_topup_20',
        purchaseOptionId: 'option_1',
      });
    });
    act(() => result.current.close());
    expect(result.current.state.open).toBe(false);

    await act(async () => {
      release(pendingOrder());
      await started;
    });

    // 关闭已结束该结算会话：迟到的创建响应不得重开弹窗或恢复旧支付动作。
    expect(result.current.state).toMatchObject({ open: false, phase: 'IDLE', order: null });
  });

  it('ignores a late refresh error after the dialog is closed', async () => {
    const order = pendingOrder();
    api.createTopup.mockResolvedValue(order);
    let reject!: (error: unknown) => void;
    api.refreshTopup.mockImplementation(() => new Promise((_, rej) => (reject = rej)));
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refreshActive();
    });
    act(() => result.current.close());
    await act(async () => {
      reject(new Error('offline'));
      await refreshing;
    });

    expect(result.current.state).toMatchObject({ open: false, phase: 'IDLE', error: false });
  });

  it('does not let a queued poll callback refresh the abandoned order after close', async () => {
    const order = pendingOrder();
    api.createTopup.mockResolvedValue(order);
    let queuedFocus: EventListener | null = null;
    const addEventListener = vi.spyOn(window, 'addEventListener');
    addEventListener.mockImplementation((type, listener) => {
      if (type === 'focus') queuedFocus = listener as EventListener;
    });
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    expect(queuedFocus).not.toBeNull();

    await act(async () => {
      result.current.close();
      queuedFocus!(new Event('focus'));
      await Promise.resolve();
    });

    expect(api.refreshTopup).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ open: false, phase: 'IDLE', order: null });
  });

  it('retries a failed order through the retry endpoint with a new key', async () => {
    const failed = { ...pendingOrder(), status: 'FAILED' as const, paymentAction: null };
    api.createTopup.mockResolvedValueOnce(failed);
    api.retryTopup.mockResolvedValueOnce(pendingOrder());
    const { result } = renderHook(() => useBillingCheckout(ACCOUNT_ID));

    await act(() =>
      result.current.startTopup({ offerCode: 'credit_topup_20', purchaseOptionId: 'option_1' }),
    );
    expect(result.current.state.phase).toBe('FAILED');

    await act(() => result.current.retry());
    expect(api.retryTopup).toHaveBeenCalledWith(failed.orderId, expect.stringMatching(/^desktop:retry:/));
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');
  });
});
