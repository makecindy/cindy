import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import { BILLING_INVOKE } from '../../../shared/billing.js';
import { ServerApiError } from '../../serverApiClient.js';
import { createBillingHandlers } from '../index.js';

function harness() {
  const mainFrame = { routingId: 1 };
  const mainWebContents = { id: 1, mainFrame };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: mainWebContents,
  } as unknown as BrowserWindow;
  const now = '2026-07-23T12:00:00.000Z';
  const paymentOrder = {
    orderId: 'order_1',
    productCode: 'credit_topup',
    offerCode: 'credit_topup_custom',
    amount: '20',
    currency: 'cny',
    status: 'PENDING',
    paymentAction: null,
    createdAt: now,
    updatedAt: now,
  };
  const subscription = {
    subscriptionId: 'subscription_1',
    status: 'INCOMPLETE',
    currentPeriodStartAt: null,
    currentPeriodEndAt: null,
    entitlementValidUntil: null,
    cancelAtPeriodEnd: false,
    effectivePlan: null,
    purchaseAttemptId: 'attempt_1',
    paymentAction: null,
  };
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/model-access/balance') {
      return {
        planCredits: '7.000000001',
        purchasedCredits: '5.000000002',
        promotionalCredits: '0.345678898',
        available: '12.345678901',
        scale: 9,
        observedAt: now,
      };
    }
    if (path === '/api/billing/catalog') return { products: [] };
    if (path === '/api/billing/orders?limit=20') return { orders: [], nextCursor: null };
    if (path === '/api/billing/subscription') return { subscription };
    if (path.includes('/subscriptions')) return subscription;
    return paymentOrder;
  }) as unknown as NonNullable<Parameters<typeof createBillingHandlers>[0]['fetch']> &
    ReturnType<typeof vi.fn>;
  const openExternal = vi.fn(async () => undefined);
  const handlers = createBillingHandlers({
    getMainWindow: () => mainWindow,
    getBaseUrl: () => 'https://model-access.example',
    fetch,
    openExternal,
  });
  const call = (
    channel: string,
    payload?: unknown,
    sender: unknown = mainWebContents,
    senderFrame: unknown = mainFrame,
  ) => handlers[channel]!({ sender, senderFrame } as never, payload);
  return { call, fetch, mainFrame, mainWebContents, openExternal };
}

describe('billing IPC', () => {
  it('queries the fixed current-account balance endpoint without a renderer payload', async () => {
    const { call, fetch } = harness();

    await expect(call(BILLING_INVOKE.GET_BALANCE)).resolves.toEqual({
      planCredits: '7.000000001',
      purchasedCredits: '5.000000002',
      promotionalCredits: '0.345678898',
      available: '12.345678901',
      scale: 9,
      observedAt: '2026-07-23T12:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledWith('/api/model-access/balance', {
      baseUrl: 'https://model-access.example',
      timeoutMs: 20_000,
      redactErrorDetails: true,
    });
  });

  it('rejects any balance payload before network access', async () => {
    const { call, fetch } = harness();

    await expect(call(BILLING_INVOKE.GET_BALANCE, {})).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['INTERNAL', 501, 'UNSUPPORTED_CAPABILITY'],
    ['INTERNAL', 503, 'MODEL_ACCESS_FAILED'],
  ])('maps balance error %s (%i) to safe IPC code %s', async (serverCode, statusCode, ipcCode) => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError(serverCode, statusCode, 'sensitive detail'));

    await expect(call(BILLING_INVOKE.GET_BALANCE)).rejects.toMatchObject({
      code: ipcCode,
    });
  });

  it('rejects a malformed balance snapshot as an invalid server response', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      planCredits: '7',
      purchasedCredits: '5',
      promotionalCredits: '4',
      available: '999',
      scale: 9,
      observedAt: '2026-07-23T12:00:00.000Z',
    });

    await expect(call(BILLING_INVOKE.GET_BALANCE)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] billing service response was invalid',
    });
  });

  it('maps a top-up to the fixed model-access endpoint and idempotency header', async () => {
    const { call, fetch } = harness();
    await call(BILLING_INVOKE.CREATE_TOPUP, {
      request: {
        offerCode: 'credit_topup_custom',
        amount: '20.00',
        purchaseOptionId: 'listing_alipay',
      },
      idempotencyKey: 'desktop:topup:12345678',
    });

    expect(fetch).toHaveBeenCalledWith('/api/billing/credit-topup/orders', {
      baseUrl: 'https://model-access.example',
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
      body: {
        offerCode: 'credit_topup_custom',
        amount: '20.00',
        purchaseOptionId: 'listing_alipay',
      },
      headers: { 'Idempotency-Key': 'desktop:topup:12345678' },
    });
  });

  it('encodes resource ids and fixes the refresh method', async () => {
    const { call, fetch } = harness();
    await call(BILLING_INVOKE.REFRESH_SUBSCRIPTION_PURCHASE, {
      purchaseAttemptId: 'attempt/1',
    });
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscriptions/purchases/attempt%2F1/refresh', {
      baseUrl: 'https://model-access.example',
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
    });
  });

  it('rejects non-main-window senders before network access', async () => {
    const { call, fetch } = harness();
    await expect(call(BILLING_INVOKE.GET_CATALOG, undefined, { id: 2 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-top-level frames in the main window before network access', async () => {
    const { call, fetch, mainWebContents } = harness();
    await expect(
      call(BILLING_INVOKE.GET_CATALOG, undefined, mainWebContents, { routingId: 2 }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and invalid idempotency keys', async () => {
    const { call, fetch } = harness();
    await expect(
      call(BILLING_INVOKE.CREATE_SUBSCRIPTION, {
        request: {
          offerCode: 'plus_month',
          purchaseOptionId: 'listing_alipay',
          provider: 'alipay',
        },
        idempotencyKey: 'short',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds order list requests', async () => {
    const { call, fetch } = harness();
    await expect(call(BILLING_INVOKE.LIST_ORDERS, { limit: 101 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('converts backend failures to the IPC error protocol without leaking details', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(
      new ServerApiError('UPSTREAM_SECRET_CODE', 500, 'sensitive backend response'),
    );

    await expect(call(BILLING_INVOKE.GET_CATALOG)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] billing service request failed',
    });
  });

  it('converts malformed single-resource responses to a fixed INTERNAL error', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      orderId: 'order_1',
      status: 'FUTURE_STATUS',
      providerError: 'private response detail',
    });

    await expect(call(BILLING_INVOKE.GET_ORDER, { orderId: 'order_1' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] billing service response was invalid',
    });
  });

  it('fail-closes an unknown current subscription status instead of returning no subscription', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
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
    });

    await expect(call(BILLING_INVOKE.GET_CURRENT_SUBSCRIPTION)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] billing service response was invalid',
    });
  });

  it('opens only public HTTPS Stripe Checkout URLs from the main top-level frame', async () => {
    const { call, openExternal } = harness();
    const url = 'https://checkout.stripe.com/c/pay/session_fixture#fragment';

    await expect(call(BILLING_INVOKE.OPEN_PAYMENT_REDIRECT, { url })).resolves.toEqual({
      success: true,
    });
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    'http://checkout.stripe.com/c/pay/test',
    'file:///tmp/payment.html',
    'javascript:alert(1)',
    'stripe://checkout/session',
    'https://checkout.stripe.com.evil.example/c/pay/test',
    'https://checkout.stripe.com@evil.example/c/pay/test',
    'https://user:password@checkout.stripe.com/c/pay/test',
    'https://checkout.stripe.com:444/c/pay/test',
    `https://checkout.stripe.com/c/pay/${'x'.repeat(2_100)}`,
  ])('rejects an unsafe billing redirect without opening it: %s', async (url) => {
    const { call, openExternal } = harness();
    await expect(call(BILLING_INVOKE.OPEN_PAYMENT_REDIRECT, { url })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects billing redirects from a child frame', async () => {
    const { call, mainWebContents, openExternal } = harness();
    await expect(
      call(
        BILLING_INVOKE.OPEN_PAYMENT_REDIRECT,
        { url: 'https://checkout.stripe.com/c/pay/test' },
        mainWebContents,
        { routingId: 2 },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects billing redirects from a different window', async () => {
    const { call, openExternal } = harness();
    await expect(
      call(
        BILLING_INVOKE.OPEN_PAYMENT_REDIRECT,
        { url: 'https://checkout.stripe.com/c/pay/test' },
        { id: 2 },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
