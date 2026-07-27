// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getCurrentSubscription: vi.fn(),
  quotePlanChange: vi.fn(),
  confirmPlanChange: vi.fn(),
  refreshPlanChange: vi.fn(),
  cancelPlanChange: vi.fn(),
}));

vi.mock('../api', () => ({ billingApi: api }));

import { usePlanChange } from '../usePlanChange';
import type { BillingPlanChange } from '../../../../shared/billing';

const ACCOUNT_ID = 'account-fixture';

function change(overrides: Partial<BillingPlanChange> = {}): BillingPlanChange {
  return {
    planChangeId: 'plan_change_1',
    changeType: 'UPGRADE',
    status: 'QUOTED',
    quotedAmountMinor: 1500,
    quotedCurrency: 'cny',
    quoteExpiresAt: '2099-01-01T00:00:00.000Z',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    paymentAction: null,
    ...overrides,
  };
}

const TARGET_PLAN = {
  product: { code: 'max', level: 300 },
  offer: { code: 'max_month', interval: 'MONTH' as const },
  terms: { amount: '50', currency: 'cny', creditAmount: '50' },
};

describe('usePlanChange', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(api)) mock.mockReset();
    api.getCurrentSubscription.mockResolvedValue({ subscription: null });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    let uuid = 0;
    vi.stubGlobal('crypto', {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    });
  });

  it('runs quote → confirm → applied and settles exactly once', async () => {
    const onSettled = vi.fn();
    api.quotePlanChange.mockResolvedValue(change());
    api.confirmPlanChange.mockResolvedValue(change({ status: 'AWAITING_PAYMENT' }));
    api.refreshPlanChange.mockResolvedValue(change({ status: 'APPLIED' }));
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    expect(result.current.state).toMatchObject({
      open: true,
      phase: 'QUOTE_READY',
      targetPlan: TARGET_PLAN,
    });

    await act(() => result.current.confirm());
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');

    await act(() => result.current.refresh());
    await act(() => result.current.refresh());
    expect(result.current.state.phase).toBe('APPLIED');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('APPLIED');
  });

  it.each(['FAILED', 'EXPIRED'] as const)(
    'notifies the parent when a pending plan change becomes %s',
    async (status) => {
      const onSettled = vi.fn();
      api.quotePlanChange.mockResolvedValue(change());
      api.confirmPlanChange.mockResolvedValue(change({ status: 'AWAITING_PAYMENT' }));
      api.refreshPlanChange.mockResolvedValue(change({ status }));
      const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

      await act(() => result.current.startQuote('max_month', TARGET_PLAN));
      await act(() => result.current.confirm());
      await act(() => result.current.refresh());

      expect(result.current.state.phase).toBe(status);
      expect(onSettled).toHaveBeenCalledWith(status);
    },
  );

  it('keeps the alipay QR from confirm and does not re-quote on refresh', async () => {
    const qr = {
      type: 'QR_CODE' as const,
      value: 'https://qr.alipay.example/pay',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    api.quotePlanChange.mockResolvedValue(change());
    api.confirmPlanChange.mockResolvedValue(
      change({ status: 'AWAITING_PAYMENT', paymentAction: qr }),
    );
    api.refreshPlanChange.mockResolvedValue(
      change({ status: 'AWAITING_PAYMENT', paymentAction: qr }),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.confirm());
    await act(() => result.current.refresh());

    expect(result.current.state.planChange?.paymentAction).toEqual(qr);
    expect(api.quotePlanChange).toHaveBeenCalledTimes(1);
    expect(api.refreshPlanChange).toHaveBeenCalledWith('plan_change_1');
  });

  it('polls a provider-pending change without confirming it again', async () => {
    const onSettled = vi.fn();
    api.quotePlanChange.mockResolvedValue(change());
    api.confirmPlanChange.mockResolvedValue(change({ status: 'PENDING_PROVIDER' }));
    api.refreshPlanChange.mockResolvedValue(change({ status: 'APPLIED' }));
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.confirm());
    expect(result.current.state.phase).toBe('PENDING_PROVIDER');

    await act(() => result.current.confirm());
    expect(api.confirmPlanChange).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.state.phase).toBe('APPLIED'));
    expect(api.refreshPlanChange).toHaveBeenCalledWith('plan_change_1');
    expect(onSettled).toHaveBeenCalledWith('APPLIED');
  });

  it('schedules a downgrade and notifies so the pending banner can refresh', async () => {
    const onSettled = vi.fn();
    api.quotePlanChange.mockResolvedValue(
      change({ changeType: 'DOWNGRADE', quotedAmountMinor: null, quotedCurrency: null }),
    );
    api.confirmPlanChange.mockResolvedValue(
      change({ changeType: 'DOWNGRADE', status: 'SCHEDULED', quotedAmountMinor: null }),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

    await act(() => result.current.startQuote('plus_month', null));
    await act(() => result.current.confirm());

    expect(result.current.state.phase).toBe('SCHEDULED');
    expect(onSettled).toHaveBeenCalledWith('SCHEDULED');
  });

  it('cancels a scheduled downgrade (undo)', async () => {
    const onSettled = vi.fn();
    api.cancelPlanChange.mockResolvedValue(change({ changeType: 'DOWNGRADE', status: 'CANCELED' }));
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

    await act(() => result.current.cancelChange('plan_change_1'));

    expect(api.cancelPlanChange).toHaveBeenCalledWith('plan_change_1');
    expect(onSettled).toHaveBeenCalledWith('CANCELED');
  });

  it('ignores duplicate confirm clicks while a request is in flight', async () => {
    api.quotePlanChange.mockResolvedValue(change());
    let release!: (value: BillingPlanChange) => void;
    api.confirmPlanChange.mockImplementation(
      () => new Promise<BillingPlanChange>((resolve) => (release = resolve)),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    let first!: Promise<void>;
    act(() => {
      first = result.current.confirm();
      void result.current.confirm();
    });
    release(change({ status: 'AWAITING_PAYMENT' }));
    await act(() => first);

    expect(api.confirmPlanChange).toHaveBeenCalledTimes(1);
  });

  it('re-reads the server state when confirm fails, instead of restoring a stale quote', async () => {
    const onSettled = vi.fn();
    api.quotePlanChange.mockResolvedValue(
      change({ changeType: 'DOWNGRADE', quotedAmountMinor: null }),
    );
    api.confirmPlanChange.mockRejectedValue(new Error('network'));
    api.refreshPlanChange.mockResolvedValue(
      change({ changeType: 'DOWNGRADE', status: 'SCHEDULED', quotedAmountMinor: null }),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, onSettled));

    await act(() => result.current.startQuote('plus_month', null));
    await act(() => result.current.confirm());

    expect(api.refreshPlanChange).toHaveBeenCalledWith('plan_change_1');
    expect(result.current.state).toMatchObject({ phase: 'SCHEDULED', error: false });
    expect(onSettled).toHaveBeenCalledWith('SCHEDULED');
  });

  it('flags an error but keeps the quote when confirm fails and the change did not progress', async () => {
    api.quotePlanChange.mockResolvedValue(change());
    api.confirmPlanChange.mockRejectedValue(new Error('network'));
    api.refreshPlanChange.mockResolvedValue(change());
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.confirm());

    expect(result.current.state).toMatchObject({
      phase: 'QUOTE_READY',
      error: true,
      stale: false,
    });
  });

  it('marks the snapshot stale when the recovery read also fails, then resyncs', async () => {
    api.quotePlanChange.mockResolvedValue(change());
    api.confirmPlanChange.mockRejectedValue(new Error('network'));
    api.refreshPlanChange.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.confirm());

    expect(result.current.state).toMatchObject({
      phase: 'QUOTE_READY',
      error: true,
      stale: true,
    });

    // Connectivity returns: the next read swaps in the server truth and clears
    // the stale flag, so the change becomes actionable again.
    api.refreshPlanChange.mockResolvedValue(change({ status: 'AWAITING_PAYMENT' }));
    await act(() => result.current.refresh());
    expect(result.current.state).toMatchObject({
      phase: 'AWAITING_PAYMENT',
      error: false,
      stale: false,
    });
  });

  it.each([
    ['[PLAN_CHANGE_NOT_AVAILABLE] target offer is not allowed', 'TARGET_NOT_ALLOWED'],
    [
      'Error invoking remote method: Error: [PRECONDITION_FAILED] subscription changed',
      'REQUEST_FAILED',
    ],
    ['[INVALID_PARAMS] targetOfferCode is invalid', 'REQUEST_FAILED'],
    ['[INTERNAL] billing service request failed', 'REQUEST_FAILED'],
  ] as const)('classifies a quote failure from the IPC error protocol', async (message, reason) => {
    api.quotePlanChange.mockRejectedValue(new Error(message));
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));

    expect(result.current.state).toMatchObject({
      phase: 'FAILED',
      error: true,
      quoteFailureReason: reason,
    });
  });

  it('generates a fresh idempotency key for every new quote attempt', async () => {
    // 服务端在新报价时自动撤销旧未完成变更；客户端不再复用失败请求的键。
    api.quotePlanChange.mockRejectedValueOnce(new Error('network'));
    api.quotePlanChange.mockResolvedValueOnce(change());
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.startQuote('max_month', TARGET_PLAN));

    expect(api.quotePlanChange).toHaveBeenCalledTimes(2);
    expect(api.quotePlanChange.mock.calls[0]![1]).not.toBe(api.quotePlanChange.mock.calls[1]![1]);
  });

  it('lets a new target start immediately after closing during an in-flight refresh', async () => {
    api.quotePlanChange
      .mockResolvedValueOnce(change())
      .mockResolvedValueOnce(change({ planChangeId: 'plan_change_2' }));
    let releaseRefresh!: (value: BillingPlanChange) => void;
    api.refreshPlanChange.mockImplementation(
      () => new Promise<BillingPlanChange>((resolve) => (releaseRefresh = resolve)),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });

    await act(async () => {
      result.current.close();
      await result.current.startQuote('plus_month', null);
    });
    expect(api.quotePlanChange).toHaveBeenCalledTimes(2);
    expect(result.current.state.planChange?.planChangeId).toBe('plan_change_2');

    await act(async () => {
      releaseRefresh(change({ status: 'APPLIED' }));
      await refreshing;
    });
    expect(result.current.state.planChange?.planChangeId).toBe('plan_change_2');
  });

  it('starts from a clean state on mount and never replays persisted intents', async () => {
    localStorage.setItem(
      `cindy.billing.plan-change-intent.v1:${encodeURIComponent(ACCOUNT_ID)}`,
      JSON.stringify({
        version: 1,
        targetOfferCode: 'max_month',
        idempotencyKey: 'desktop:plan-change:12345678',
        planChangeId: 'plan_change_1',
        createdAt: '2026-07-24T00:00:00.000Z',
      }),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await Promise.resolve();
    expect(result.current.state.phase).toBe('IDLE');
    expect(result.current.state.open).toBe(false);
    expect(api.refreshPlanChange).not.toHaveBeenCalled();
    expect(api.quotePlanChange).not.toHaveBeenCalled();
  });
});
