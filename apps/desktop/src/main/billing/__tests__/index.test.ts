import { describe, expect, it, vi } from 'vitest';
import { BILLING_CURRENCY } from '../../../shared/billingCurrency.js';
import type { BrowserWindow } from 'electron';

import { BILLING_INVOKE } from '../../../shared/billing.js';
import { ServerApiError } from '../../serverApiClient.desktop.js';
import { createBillingHandlers } from '../index.js';

vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: vi.fn() }));
vi.mock('../../serverApiClient.desktop.js', () => {
  class ServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
      // 与真实 ServerApiError 一致：429 时带 Retry-After 换算出的时间戳。
      public readonly retryAt?: number,
    ) {
      super(message);
    }
  }
  return { ServerApiError, serverApiFetch: vi.fn() };
});

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
    if (path.startsWith('/api/billing/payment-history?')) return { records: [], nextCursor: null };
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
  // 新成功历史必须经固定账号接口取下一页，renderer 不得覆盖账号或请求路径。
  it('passes a bounded history cursor to the fixed personal history endpoint', async () => {
    const { call, fetch } = harness();
    await expect(call('billing:list-payment-history', { limit: 10, cursor: 'previous_page' }))
      .resolves.toEqual({ records: [], nextCursor: null });
    expect(fetch).toHaveBeenCalledWith(
      '/api/billing/payment-history?limit=10&cursor=previous_page&includeGiftCards=true',
      {
        baseUrl: expect.any(Function), timeoutMs: 20_000, redactErrorDetails: true,
        expectedErrors: [{ status: 400 }],
      },
    );
  });

  // 新版桌面端先于服务端上线时，旧服务端不认识 includeGiftCards（400）：订单记录不能因此打不开。
  it('falls back to the plain history request when the server does not know gift cards yet', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'redacted'));
    await expect(call('billing:list-payment-history', { limit: 10 }))
      .resolves.toEqual({ records: [], nextCursor: null });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/billing/payment-history?limit=10&includeGiftCards=true',
      '/api/billing/payment-history?limit=10',
    ]);
  });

  // 评审发现（PR #11412）：别的 400（比如游标过期）回退也会失败，不能因此记成「暂不支持」、10 分钟
  // 都不带 includeGiftCards。只有不带参数的请求成功了才记下。
  it('only remembers the legacy server once the plain request succeeds', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'redacted'))
      .mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'redacted'));
    await expect(call('billing:list-payment-history', { limit: 10, cursor: 'expired_page' })).rejects.toBeTruthy();
    await call('billing:list-payment-history', { limit: 10 });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/billing/payment-history?limit=10&cursor=expired_page&includeGiftCards=true',
      '/api/billing/payment-history?limit=10&cursor=expired_page',
      '/api/billing/payment-history?limit=10&includeGiftCards=true',
    ]);
  });

  // 评审发现（PR #11412）：旧服务端每次读付款记录都要先白跑一趟必然 400 的请求。记下这个地址暂不支持，
  // 期间直接走原来的请求；过一段时间再试，服务端升级后自动恢复。
  it('remembers for a while that the server does not know gift cards yet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-19T08:00:00.000Z'));
      const { call, fetch } = harness();
      fetch.mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'redacted'));
      await call('billing:list-payment-history', { limit: 10 });
      await call('billing:list-payment-history', { limit: 10, cursor: 'next_page' });
      vi.setSystemTime(new Date('2026-11-19T08:11:00.000Z'));
      await call('billing:list-payment-history', { limit: 10 });
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        '/api/billing/payment-history?limit=10&includeGiftCards=true',
        '/api/billing/payment-history?limit=10',
        '/api/billing/payment-history?limit=10&cursor=next_page',
        '/api/billing/payment-history?limit=10&includeGiftCards=true',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: 10, cursor: '../other' },
    { limit: 10, cursor: 'a'.repeat(1025) }, { limit: 10, membershipId: 'another-account' },
  ])('rejects unsafe history payload before network access: %j', async (payload) => {
    const { call, fetch } = harness();
    await expect(call('billing:list-payment-history', payload)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fetch).not.toHaveBeenCalled();
  });

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
    BILLING_INVOKE.OPEN_SUBSCRIPTION_PORTAL,
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

  it('resumes the current subscription through one fixed provider-neutral POST', async () => {
    const { call, fetch } = harness();
    const resumed = {
      subscriptionId: 'subscription_1',
      status: 'ACTIVE',
      currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
      currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
      entitlementValidUntil: '2026-08-02T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      resumable: false,
      effectivePlan: null,
      purchaseAttemptId: null,
      paymentAction: null,
    };
    fetch.mockResolvedValueOnce(resumed);

    await expect(call(BILLING_INVOKE.RESUME_CURRENT_SUBSCRIPTION)).resolves.toEqual(resumed);
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscription/resume', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
      allowedRedactedErrorCodes: ['RESUME_NOT_AVAILABLE'],
    });
  });

  it('preserves the safe subscription-resume rejection code across IPC', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(
      new ServerApiError(
        'RESUME_NOT_AVAILABLE',
        409,
        'upstream detail must not reach the renderer',
      ),
    );

    await expect(call(BILLING_INVOKE.RESUME_CURRENT_SUBSCRIPTION)).rejects.toMatchObject({
      code: 'RESUME_NOT_AVAILABLE',
      message: '[RESUME_NOT_AVAILABLE] subscription is not resumable',
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
      allowedRedactedErrorCodes: ['PLAN_CHANGE_NOT_AVAILABLE', 'PLAN_CHANGE_RENEWAL_PREPAID'],
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

  it.each([
    [
      BILLING_INVOKE.QUOTE_PLAN_CHANGE,
      { targetOfferCode: 'max_month', idempotencyKey: 'desktop:plan-change:12345678' },
    ],
    [BILLING_INVOKE.CONFIRM_PLAN_CHANGE, { planChangeId: 'plan_change_1' }],
  ])(
    'preserves prepaid renewal rejection without exposing upstream text: %s',
    async (channel, payload) => {
      const { call, fetch } = harness();
      fetch.mockRejectedValueOnce(
        new ServerApiError('PLAN_CHANGE_RENEWAL_PREPAID', 409, 'private upstream detail'),
      );
      await expect(call(channel, payload)).rejects.toMatchObject({
        code: 'PLAN_CHANGE_RENEWAL_PREPAID',
        message: '[PLAN_CHANGE_RENEWAL_PREPAID] next renewal is already paid',
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          allowedRedactedErrorCodes: expect.arrayContaining(['PLAN_CHANGE_RENEWAL_PREPAID']),
        }),
      );
    },
  );

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

  it('creates and opens a Stripe portal session only in the main process', async () => {
    const { call, fetch, openExternal } = harness();
    const url = 'https://billing.stripe.com/p/session/session_fixture';
    fetch.mockResolvedValueOnce({ url });

    await expect(call(BILLING_INVOKE.OPEN_SUBSCRIPTION_PORTAL)).resolves.toEqual({
      success: true,
    });
    expect(fetch).toHaveBeenCalledWith('/api/billing/subscription/portal', {
      baseUrl: expect.any(Function),
      timeoutMs: 20_000,
      redactErrorDetails: true,
      method: 'POST',
    });
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('releases a stalled Stripe portal browser launch', async () => {
    vi.useFakeTimers();
    try {
      const { call, fetch, openExternal } = harness();
      const url = 'https://billing.stripe.com/p/session/session_fixture';
      fetch.mockResolvedValueOnce({ url });
      openExternal.mockImplementationOnce(() => new Promise<undefined>(() => {}));

      const pending = call(BILLING_INVOKE.OPEN_SUBSCRIPTION_PORTAL);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toEqual({ success: false, timedOut: true });
      expect(openExternal).toHaveBeenCalledWith(url);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the portal endpoint does not return a Stripe portal URL', async () => {
    const { call, fetch, openExternal } = harness();
    fetch.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay/session_fixture' });

    await expect(call(BILLING_INVOKE.OPEN_SUBSCRIPTION_PORTAL)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(openExternal).not.toHaveBeenCalled();
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

describe('gift card IPC', () => {
  const card = {
    status: 'AVAILABLE',
    source: 'PLATFORM',
    amount: '20',
    currency: 'USD',
    faceCode: 'cindy',
    senderName: 'Cindy Team',
    message: null,
    claimDeadline: '2026-12-31T16:00:00.000Z',
    validityDays: 90,
    claimedAt: null,
  };
  const projected = {
    status: 'AVAILABLE',
    amount: '20',
    faceCode: 'cindy',
    senderName: 'Cindy Team',
    message: null,
    destination: 'PROMOTIONAL',
    claimDeadline: '2026-12-31T16:00:00.000Z',
    validityDays: 90,
    claimedAt: null,
  };

  it('sends the normalized code in the request body and returns only the fields the dialog shows', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({ card });

    await expect(call(BILLING_INVOKE.PREVIEW_GIFT_CARD, { code: ' g012-3456-789a-bcde ' }))
      .resolves.toEqual({ ok: true, card: projected });

    const [path, options] = fetch.mock.calls[0]!;
    // 兑换码不出现在路径里；上游错误细节脱敏，只放行礼品卡状态码。
    expect(path).toBe('/api/gift-cards/preview');
    expect(options).toMatchObject({
      method: 'POST',
      body: { code: 'G0123456789ABCDE' },
      redactErrorDetails: true,
      allowedRedactedErrorCodes: expect.arrayContaining(['GIFT_CARD_ALREADY_CLAIMED', 'GIFT_CARD_WRONG_REGION']),
    });
  });

  it('returns the credit state from redeem so a pending credit is not shown as failed', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' },
      credit: { state: 'PENDING', amount: '20', expiresAt: null },
    });

    await expect(call(BILLING_INVOKE.REDEEM_GIFT_CARD, { code: 'G0123456789ABCDE' })).resolves.toEqual({
      ok: true,
      card: { ...projected, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' },
      credit: { state: 'PENDING', amount: '20', expiresAt: null },
    });
    expect(fetch.mock.calls[0]![0]).toBe('/api/gift-cards/redeem');
  });

  it.each([
    ['GIFT_CARD_NOT_FOUND', 404, 'NOT_FOUND'],
    ['GIFT_CARD_WRONG_REGION', 409, 'WRONG_REGION'],
    ['GIFT_CARD_ALREADY_CLAIMED', 409, 'ALREADY_CLAIMED'],
    ['GIFT_CARD_EXPIRED', 409, 'EXPIRED'],
    ['GIFT_CARD_VOIDED', 409, 'VOIDED'],
    ['RATE_LIMITED', 429, 'RATE_LIMITED'],
  ])('reports %s as a card state instead of a generic failure', async (code, status, reason) => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError(code, status, 'redacted'));

    await expect(call(BILLING_INVOKE.REDEEM_GIFT_CARD, { code: 'G0123456789ABCDE' }))
      .resolves.toEqual({ ok: false, reason });
  });

  it('treats text that is not a redeem code as invalid without a network request', async () => {
    const { call, fetch } = harness();

    await expect(call(BILLING_INVOKE.PREVIEW_GIFT_CARD, { code: 'https://share.cindy.app/gift' }))
      .resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(call(BILLING_INVOKE.PREVIEW_GIFT_CARD, { code: 'G0123456789ABCDE', membershipId: 'other' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps service failures and malformed responses as errors, never as a redeemed card', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError('INTERNAL_ERROR', 500, 'redacted'));
    await expect(call(BILLING_INVOKE.REDEEM_GIFT_CARD, { code: 'G0123456789ABCDE' }))
      .rejects.toMatchObject({ code: 'INTERNAL' });

    fetch.mockResolvedValueOnce({ card: { ...card, status: 'SOMETHING_NEW' }, credit: { state: 'APPLIED', amount: '20', expiresAt: null } });
    await expect(call(BILLING_INVOKE.REDEEM_GIFT_CARD, { code: 'G0123456789ABCDE' }))
      .rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('is only available to the main window', async () => {
    const { call, fetch } = harness();
    await expect(call(BILLING_INVOKE.REDEEM_GIFT_CARD, { code: 'G0123456789ABCDE' }, { id: 2 }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('gift card purchase IPC', () => {
  const request = {
    offerCode: 'gift_card_100',
    quantity: 2,
    faceCode: 'cat',
    senderName: '  小鱼 ',
    message: '   ',
    purchaseOptionId: 'listing_alipay',
  };

  it('creates the order at the fixed endpoint with trimmed text and the idempotency header', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      orderId: 'order_9', productCode: 'gift_card', offerCode: 'gift_card_100', amount: '200',
      currency: BILLING_CURRENCY, status: 'PENDING', paymentAction: null, productKind: 'GIFT_CARD', quantity: 2,
      createdAt: '2026-11-19T08:00:00.000Z', updatedAt: '2026-11-19T08:00:00.000Z',
    });

    await expect(call(BILLING_INVOKE.CREATE_GIFT_CARD_ORDER, {
      request, idempotencyKey: 'desktop:gift-card:12345678',
    })).resolves.toMatchObject({ orderId: 'order_9', productKind: 'GIFT_CARD', quantity: 2 });

    expect(fetch).toHaveBeenCalledWith('/api/billing/gift-card/orders', expect.objectContaining({
      method: 'POST',
      body: { ...request, senderName: '小鱼', message: null },
      headers: { 'Idempotency-Key': 'desktop:gift-card:12345678' },
      allowedRedactedErrorCodes: expect.arrayContaining(['GIFT_CARD_PURCHASE_LIMIT_REACHED']),
    }));
  });

  // 自填面额的方案把单张面额带给服务端；固定面额方案的请求不带这个字段（上一条用例）。
  it('forwards a buyer-entered face value', async () => {
    const { call, fetch } = harness();
    fetch.mockResolvedValueOnce({
      orderId: 'order_10', productCode: 'gift_card', offerCode: 'gift_card_custom', amount: '466.5',
      currency: BILLING_CURRENCY, status: 'PENDING', paymentAction: null, productKind: 'GIFT_CARD', quantity: 2,
      createdAt: '2026-11-19T08:00:00.000Z', updatedAt: '2026-11-19T08:00:00.000Z',
    });
    await call(BILLING_INVOKE.CREATE_GIFT_CARD_ORDER, {
      request: { ...request, offerCode: 'gift_card_custom', amount: '233.25' },
      idempotencyKey: 'desktop:gift-card:12345678',
    });
    expect(fetch).toHaveBeenCalledWith('/api/billing/gift-card/orders', expect.objectContaining({
      body: expect.objectContaining({ offerCode: 'gift_card_custom', amount: '233.25' }),
    }));
  });

  it.each([
    { ...request, amount: '100.555' },
    { ...request, amount: 100 },
    { ...request, amount: '-5' },
    { ...request, quantity: 0 },
    { ...request, quantity: 1.5 },
    { ...request, faceCode: '../face' },
    { ...request, senderName: '   ' },
    { ...request, membershipId: 'someone-else' },
  ])('rejects an order the server should never see: %j', async (bad) => {
    const { call, fetch } = harness();
    await expect(call(BILLING_INVOKE.CREATE_GIFT_CARD_ORDER, {
      request: bad, idempotencyKey: 'desktop:gift-card:12345678',
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  // 发到邮箱：只把收件邮箱放进请求体；服务端明确拒绝的几种情况作为结果交给界面就地说明
  // （冷却带上可以再发的时间），其它失败沿用统一错误。明显不是单个地址的输入不发请求。
  describe('send a purchased gift card by email', () => {
    const cardId = '1f0c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    const sentCard = {
      cardId, orderId: 'order_9', faceCode: 'cat', amount: '100', currency: BILLING_CURRENCY.toUpperCase(), senderName: '小鱼',
      message: null, codeTail: '7KQ2', status: 'UNCLAIMED', claimedAt: null, claimedByName: null,
      purchasedAt: '2026-11-19T08:00:00.000Z',
      email: {
        recipient: 'friend@example.com', status: 'PENDING',
        updatedAt: '2026-11-19T08:05:00.000Z', nextAvailableAt: '2026-11-19T08:06:00.000Z',
      },
    };

    it('posts the trimmed address and returns the updated card', async () => {
      const { call, fetch } = harness();
      fetch.mockResolvedValueOnce({ card: sentCard });
      await expect(call(BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL, { cardId, email: '  friend@example.com ' }))
        .resolves.toMatchObject({ ok: true, card: { cardId, email: { recipient: 'friend@example.com', status: 'PENDING' } } });
      expect(fetch).toHaveBeenCalledWith(`/api/gift-cards/purchased/${cardId}/email`, expect.objectContaining({
        method: 'POST',
        body: { email: 'friend@example.com' },
        allowedRedactedErrorCodes: expect.arrayContaining(['GIFT_CARD_EMAIL_COOLDOWN']),
      }));
    });

    it.each([
      [new ServerApiError('GIFT_CARD_RECIPIENT_INVALID', 400, 'redacted'), { ok: false, reason: 'INVALID_EMAIL' }],
      [new ServerApiError('GIFT_CARD_NOT_AVAILABLE', 409, 'redacted'), { ok: false, reason: 'NOT_AVAILABLE' }],
      [new ServerApiError('GIFT_CARD_NOT_FOUND', 404, 'redacted'), { ok: false, reason: 'NOT_AVAILABLE' }],
      [new ServerApiError('GIFT_CARD_EMAIL_COOLDOWN', 429, 'redacted', 1_795_000_060_000), { ok: false, reason: 'COOLDOWN', retryAt: 1_795_000_060_000 }],
      [new ServerApiError('GIFT_CARD_EMAIL_COOLDOWN', 429, 'redacted'), { ok: false, reason: 'COOLDOWN', retryAt: null }],
    ])('turns %s into a result the dialog can explain', async (error, expected) => {
      const { call, fetch } = harness();
      fetch.mockRejectedValueOnce(error);
      await expect(call(BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL, { cardId, email: 'friend@example.com' }))
        .resolves.toEqual(expected);
    });

    it('keeps other failures as billing errors', async () => {
      const { call, fetch } = harness();
      fetch.mockRejectedValueOnce(new ServerApiError('INTERNAL', 500, 'redacted'));
      await expect(call(BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL, { cardId, email: 'friend@example.com' }))
        .rejects.toMatchObject({ code: 'INTERNAL' });
    });

    it.each(['', 'friend', 'a@b.com, c@d.com', 'a b@example.com', `${'x'.repeat(250)}@example.com`])(
      'answers %j as an invalid address without calling the server',
      async (email) => {
        const { call, fetch } = harness();
        const calls = fetch.mock.calls.length;
        await expect(call(BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL, { cardId, email }))
          .resolves.toEqual({ ok: false, reason: 'INVALID_EMAIL' });
        expect(fetch.mock.calls.length).toBe(calls);
      },
    );

    it.each([
      // 卡号与读列表、取码同一条规则（isPurchasedGiftCardId）：只挡不是卡号的输入。
      { cardId: '../card_1', email: 'friend@example.com' },
      { cardId, email: 42 },
      { cardId, email: 'friend@example.com', membershipId: 'someone-else' },
    ])('rejects a malformed request %j', async (payload) => {
      const { call } = harness();
      await expect(call(BILLING_INVOKE.SEND_PURCHASED_GIFT_CARD_EMAIL, payload))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });
  });

  // 购买上限是明确的业务结果，要让界面说清楚，而不是当成「请求失败」。
  it('reports the purchase limit as its own error code', async () => {
    const { call, fetch } = harness();
    fetch.mockRejectedValueOnce(new ServerApiError('GIFT_CARD_PURCHASE_LIMIT_REACHED', 409, 'redacted'));
    await expect(call(BILLING_INVOKE.CREATE_GIFT_CARD_ORDER, {
      request, idempotencyKey: 'desktop:gift-card:12345678',
    })).rejects.toMatchObject({ code: 'GIFT_CARD_PURCHASE_LIMIT_REACHED' });
  });

  // 兑换码只放在链接的 fragment 里，分享站收不到；分享站地址不可信时不拼链接，只给兑换码。
  it('builds the claim link on the configured share site with the code in the fragment', async () => {
    const { fetch } = harness();
    const sender = { mainFrame: {} };
    const reveal = (shareBaseUrl: string) => createBillingHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }) as never,
      requirePersonalAccount: () => undefined,
      getBaseUrl: () => 'https://model-access.example',
      getShareBaseUrl: () => shareBaseUrl,
      fetch,
    })[BILLING_INVOKE.REVEAL_PURCHASED_GIFT_CARD]!(
      { sender, senderFrame: sender.mainFrame } as never,
      { cardId: 'card_1', faceCode: 'cat' },
    );

    fetch.mockResolvedValueOnce({ code: 'C0123456789ABCDE' });
    await expect(reveal('https://share.example.test/')).resolves.toEqual({
      code: 'C012-3456-789A-BCDE',
      claimUrl: 'https://share.example.test/gift?face=cat#C012-3456-789A-BCDE',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/gift-cards/purchased/card_1/code',
      expect.objectContaining({ method: 'POST' }),
    );

    fetch.mockResolvedValueOnce({ code: 'C0123456789ABCDE' });
    await expect(reveal('http://share.example.test')).resolves.toEqual({
      code: 'C012-3456-789A-BCDE',
      claimUrl: null,
    });
  });
});
