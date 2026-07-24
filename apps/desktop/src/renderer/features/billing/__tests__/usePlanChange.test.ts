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
import {
  billingPlanChangeIntentKey,
  readBillingPlanChangeIntent,
  writeBillingPlanChangeIntent,
} from '../checkoutIntent';
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
    expect(readBillingPlanChangeIntent(ACCOUNT_ID)).toMatchObject({
      targetOfferCode: 'max_month',
      planChangeId: 'plan_change_1',
    });

    await act(() => result.current.confirm());
    expect(result.current.state.phase).toBe('AWAITING_PAYMENT');

    await act(() => result.current.refresh());
    await act(() => result.current.refresh());
    expect(result.current.state.phase).toBe('APPLIED');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('APPLIED');
    expect(readBillingPlanChangeIntent(ACCOUNT_ID)).toBeNull();
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
    expect(readBillingPlanChangeIntent(ACCOUNT_ID)).toBeNull();
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

  it('adopts the server pending projection when the quote request fails', async () => {
    api.quotePlanChange.mockRejectedValue(new Error('conflict'));
    api.getCurrentSubscription.mockResolvedValue({
      subscription: {
        subscriptionId: 'subscription_1',
        status: 'ACTIVE',
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: false,
        effectivePlan: null,
        purchaseAttemptId: null,
        paymentAction: null,
        pendingPlanChange: {
          ...change({ status: 'SCHEDULED', changeType: 'DOWNGRADE' }),
          targetPlan: TARGET_PLAN,
        },
      },
    });
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('plus_month', null));

    expect(result.current.state).toMatchObject({
      open: true,
      phase: 'SCHEDULED',
      targetPlan: TARGET_PLAN,
    });
  });

  it('reuses the same idempotency key when retrying the same target after a failure', async () => {
    api.quotePlanChange.mockRejectedValueOnce(new Error('network'));
    api.quotePlanChange.mockResolvedValueOnce(change());
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await act(() => result.current.startQuote('max_month', TARGET_PLAN));
    await act(() => result.current.startQuote('max_month', TARGET_PLAN));

    expect(api.quotePlanChange).toHaveBeenCalledTimes(2);
    expect(api.quotePlanChange.mock.calls[0]![1]).toBe(api.quotePlanChange.mock.calls[1]![1]);
  });

  it('recovers a persisted in-flight change on restart and reopens the payment step', async () => {
    writeBillingPlanChangeIntent(ACCOUNT_ID, {
      version: 1,
      targetOfferCode: 'max_month',
      idempotencyKey: 'desktop:plan-change:12345678',
      planChangeId: 'plan_change_1',
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    api.refreshPlanChange.mockResolvedValue(
      change({
        status: 'AWAITING_PAYMENT',
        paymentAction: {
          type: 'QR_CODE',
          value: 'https://qr.alipay.example/pay',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    );
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await waitFor(() => expect(result.current.state.phase).toBe('AWAITING_PAYMENT'));
    expect(result.current.state.open).toBe(true);
    expect(api.refreshPlanChange).toHaveBeenCalledWith('plan_change_1');
    expect(api.quotePlanChange).not.toHaveBeenCalled();
  });

  it('clears a keyed intent that never produced a plan change instead of re-quoting', async () => {
    writeBillingPlanChangeIntent(ACCOUNT_ID, {
      version: 1,
      targetOfferCode: 'max_month',
      idempotencyKey: 'desktop:plan-change:12345678',
      planChangeId: null,
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await waitFor(() => expect(readBillingPlanChangeIntent(ACCOUNT_ID)).toBeNull());
    expect(api.quotePlanChange).not.toHaveBeenCalled();
    expect(api.refreshPlanChange).not.toHaveBeenCalled();
  });

  it("never reads another account's intent", async () => {
    writeBillingPlanChangeIntent('other-account', {
      version: 1,
      targetOfferCode: 'max_month',
      idempotencyKey: 'desktop:plan-change:12345678',
      planChangeId: 'plan_change_other',
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    const { result } = renderHook(() => usePlanChange(ACCOUNT_ID, vi.fn()));

    await Promise.resolve();
    expect(api.refreshPlanChange).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('IDLE');
    expect(localStorage.getItem(billingPlanChangeIntentKey('other-account'))).not.toBeNull();
  });
});
