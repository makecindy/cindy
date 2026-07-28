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
    if (path === '/api/model-access/credit-usage') {
      return {
        available: '12.345678901',
        plan: { remaining: '7.000000001', used: '3', total: '10.000000001' },
        purchased: { remaining: '5.000000002', used: '5', total: '10.000000002' },
        promotional: {
          remaining: '0.345678898',
          used: '0.654321102',
          total: '1',
        },
        promotionalGrants: [
          {
            grantId: 'welcome',
            displayName: 'Welcome',
            originalAmount: '1',
            usedAmount: '0.654321102',
            remainingAmount: '0.345678898',
            expiresAt: '2026-08-23T12:00:00.000Z',
            state: 'active',
          },
        ],
        promotionalGrantsComplete: true,
        promotionalGrantConsistency: 'OBSERVED',
        ledgerUpdatedAt: now,
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
  const requirePersonalAccount = vi.fn();
  const handlers = createBillingHandlers({
    getMainWindow: () => mainWindow,
    requirePersonalAccount,
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
  return {
    call,
    fetch,
    mainFrame,
    mainWebContents,
    openExternal,
    requirePersonalAccount,
  };
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
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
    });
    const baseUrl = fetch.mock.calls[0]?.[1]?.baseUrl;
    expect(typeof baseUrl === 'function' ? baseUrl() : baseUrl).toBe(
      'https://model-access.example',
    );
  });

  it('rejects any balance payload before network access', async () => {
    const { call, fetch } = harness();

    await expect(call(BILLING_INVOKE.GET_BALANCE, {})).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('queries the fixed current-account credit usage endpoint', async () => {
    const { call, fetch } = harness();

    await expect(call(BILLING_INVOKE.GET_CREDIT_USAGE)).resolves.toMatchObject({
      available: '12.345678901',
      plan: { remaining: '7.000000001', used: '3', total: '10.000000001' },
      promotionalGrants: [
        {
          grantId: 'welcome',
          state: 'active',
          usedAmount: '0.654321102',
          remainingAmount: '0.345678898',
        },
      ],
      promotionalGrantConsistency: 'OBSERVED',
    });
    expect(fetch).toHaveBeenCalledWith('/api/model-access/credit-usage', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
    });
  });

  it.each([
    BILLING_INVOKE.GET_CREDIT_USAGE,
    BILLING_INVOKE.GET_CATALOG,
    BILLING_INVOKE.GET_CURRENT_SUBSCRIPTION,
    BILLING_INVOKE.CANCEL_CURRENT_SUBSCRIPTION,
  ])('rejects any payload on the no-payload channel %s before network access', async (channel) => {
    const { call, fetch } = harness();

    await expect(call(channel, {})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
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
      baseUrl: expect.any(Function),
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
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
    });
  });

  it('cancels the current subscription through one fixed provider-neutral DELETE', async () => {
    const { call, fetch } = harness();
    const canceled = {
      subscriptionId: 'subscription_1',
      status: 'ACTIVE',
      currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
      currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
      entitlementValidUntil: '2026-08-02T00:00:00.000Z',
      cancelAtPeriodEnd: true,
      effectivePlan: null,
      purchaseAttemptId: null,
      paymentAction: null,
    };
    fetch.mockResolvedValueOnce(canceled);

    await expect(call(BILLING_INVOKE.CANCEL_CURRENT_SUBSCRIPTION)).resolves.toEqual(canceled);
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscription', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'DELETE',
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

  it.each(Object.values(BILLING_INVOKE))(
    'rejects account-ineligible access on %s before payload parsing or network access',
    async (channel) => {
      const { call, fetch, openExternal, requirePersonalAccount } = harness();
      requirePersonalAccount.mockImplementation(() => {
        throw Object.assign(new Error('[PERMISSION_DENIED] Billing requires a personal account.'), {
          code: 'PERMISSION_DENIED',
        });
      });

      await expect(call(channel, { invalid: true })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

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

  it('maps a plan change quote to the fixed endpoint with the idempotency header', async () => {
    const { call, fetch } = harness();
    const change = {
      planChangeId: 'plan_change_1',
      changeType: 'DOWNGRADE',
      status: 'QUOTED',
      quotedAmountMinor: null,
      quotedCurrency: null,
      quoteExpiresAt: '2026-07-23T12:05:00.000Z',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
    };
    fetch.mockResolvedValueOnce(change);

    await expect(
      call(BILLING_INVOKE.QUOTE_PLAN_CHANGE, {
        targetOfferCode: 'plus_month',
        idempotencyKey: 'desktop:plan-change:12345678',
      }),
    ).resolves.toEqual(change);
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscription/plan-change-quotes', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
      body: { targetOfferCode: 'plus_month' },
      headers: { 'Idempotency-Key': 'desktop:plan-change:12345678' },
      allowedRedactedErrorCodes: ['PLAN_CHANGE_NOT_AVAILABLE'],
    });
  });

  it('preserves the safe plan-change rejection code across IPC', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(
      new ServerApiError(
        'PLAN_CHANGE_NOT_AVAILABLE',
        409,
        'upstream detail must not reach the renderer',
      ),
    );

    await expect(
      call(BILLING_INVOKE.QUOTE_PLAN_CHANGE, {
        targetOfferCode: 'max_month',
        idempotencyKey: 'desktop:plan-change:12345678',
      }),
    ).rejects.toMatchObject({
      code: 'PLAN_CHANGE_NOT_AVAILABLE',
      message: '[PLAN_CHANGE_NOT_AVAILABLE] target plan is not available',
    });
  });

  it('rejects a plan change quote without a valid idempotency key before network access', async () => {
    const { call, fetch } = harness();
    await expect(
      call(BILLING_INVOKE.QUOTE_PLAN_CHANGE, { targetOfferCode: 'plus_month' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a plan change with DELETE and an encoded id', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      planChangeId: 'plan/1',
      changeType: 'DOWNGRADE',
      status: 'CANCELED',
      quotedAmountMinor: null,
      quotedCurrency: null,
      quoteExpiresAt: null,
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
    });

    await call(BILLING_INVOKE.CANCEL_PLAN_CHANGE, { planChangeId: 'plan/1' });
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscription/plan-changes/plan%2F1', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'DELETE',
    });
  });

  it('fail-closes an unknown plan change status from confirm', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'FUTURE_STATUS',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: null,
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
      providerError: 'private detail',
    });

    await expect(
      call(BILLING_INVOKE.CONFIRM_PLAN_CHANGE, { planChangeId: 'plan_change_1' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] billing service response was invalid',
    });
  });

  it.each([
    'https://checkout.stripe.com/c/pay/session_fixture#fragment',
    'https://invoice.stripe.com/i/acct_fixture/test_fixture',
  ])('opens a public HTTPS Stripe payment URL from the main top-level frame: %s', async (url) => {
    const { call, openExternal } = harness();

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
    'https://invoice.stripe.com.evil.example/i/test',
    'https://checkout.stripe.com@evil.example/c/pay/test',
    'https://invoice.stripe.com@evil.example/i/test',
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
