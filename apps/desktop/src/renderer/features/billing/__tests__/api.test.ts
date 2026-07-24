// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { billingApi } from '../api';

describe('billing renderer API', () => {
  const billing = {
    getBalance: vi.fn(),
    listOrders: vi.fn(),
    createTopup: vi.fn(),
    openPaymentRedirect: vi.fn(),
  };

  beforeEach(() => {
    billing.getBalance.mockReset().mockResolvedValue({ available: '12.34' });
    billing.listOrders.mockReset().mockResolvedValue({ orders: [], nextCursor: null });
    billing.createTopup.mockReset().mockResolvedValue({ orderId: 'order_fixture' });
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

  it('uses the dedicated billing redirect method', async () => {
    const url = 'https://checkout.stripe.com/c/pay/session_fixture';
    await billingApi.openPaymentRedirect(url);
    expect(billing.openPaymentRedirect).toHaveBeenCalledWith({ url });
  });
});
