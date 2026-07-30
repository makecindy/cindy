// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { billingApi } from '../api';

describe('billing renderer API', () => {
  const billing = {
    getBalance: vi.fn(),
    getCreditUsage: vi.fn(),
    listOrders: vi.fn(),
    createTopup: vi.fn(),
    cancelCurrentSubscription: vi.fn(),
    openSubscriptionPortal: vi.fn(),
    openPaymentRedirect: vi.fn(),
  };

  beforeEach(() => {
    billing.getBalance.mockReset().mockResolvedValue({ available: '12.34' });
    billing.getCreditUsage.mockReset().mockResolvedValue({ available: '12.34' });
    billing.listOrders.mockReset().mockResolvedValue({ orders: [], nextCursor: null });
    billing.createTopup.mockReset().mockResolvedValue({ orderId: 'order_fixture' });
    billing.cancelCurrentSubscription.mockReset().mockResolvedValue({
      subscriptionId: 'subscription_fixture',
      cancelAtPeriodEnd: true,
    });
    billing.openSubscriptionPortal.mockReset().mockResolvedValue({ success: true });
    billing.openPaymentRedirect.mockReset().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { billing },
    });
  });

  it('queries the current account balance without accepting renderer parameters', async () => {
    await billingApi.getBalance();
    expect(billing.getBalance).toHaveBeenCalledWith();
  });

  it('queries current account credit usage without accepting renderer parameters', async () => {
    await billingApi.getCreditUsage();
    expect(billing.getCreditUsage).toHaveBeenCalledWith();
  });

  it('uses the bounded default order page size', async () => {
    await billingApi.listOrders();
    expect(billing.listOrders).toHaveBeenCalledWith({ limit: 20 });
  });

  it('keeps the request and idempotency key inside the fixed create method', async () => {
    const request = {
      offerCode: 'credit_topup_custom',
      amount: '20.00',
      purchaseOptionId: 'listing_alipay',
    };
    await billingApi.createTopup(request, 'desktop:topup:fixture-0001');
    expect(billing.createTopup).toHaveBeenCalledWith({
      request,
      idempotencyKey: 'desktop:topup:fixture-0001',
    });
  });

  it('cancels the current subscription without exposing provider or request parameters', async () => {
    await billingApi.cancelCurrentSubscription();
    expect(billing.cancelCurrentSubscription).toHaveBeenCalledWith();
  });

  it('opens the subscription portal without exposing a provider URL or request parameters', async () => {
    await billingApi.openSubscriptionPortal();
    expect(billing.openSubscriptionPortal).toHaveBeenCalledWith();
  });

  it('uses the dedicated billing redirect method', async () => {
    const url = 'https://checkout.stripe.com/c/pay/session_fixture';
    await billingApi.openPaymentRedirect(url);
    expect(billing.openPaymentRedirect).toHaveBeenCalledWith({ url });
  });
});
