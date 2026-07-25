import { useCallback, useEffect, useRef, useState } from 'react';

import { extractIpcError } from '@/utils/ipcError';
import type {
  BillingPendingPlanChange,
  BillingPlanChange,
  BillingPlanChangeTargetPlan,
} from '../../../shared/billing';
import { billingApi } from './api';
import {
  clearBillingPlanChangeIntent,
  newBillingIdempotencyKey,
  readBillingPlanChangeIntent,
  writeBillingPlanChangeIntent,
  type BillingPlanChangeIntentV1,
} from './checkoutIntent';

export type PlanChangePhase =
  | 'IDLE'
  | 'QUOTING'
  | 'QUOTE_READY'
  | 'CONFIRMING'
  | 'PENDING_PROVIDER'
  | 'AWAITING_PAYMENT'
  | 'SCHEDULED'
  | 'APPLIED'
  | 'CANCELED'
  | 'FAILED'
  | 'EXPIRED';

export type PlanChangeTargetSnapshot = Omit<BillingPlanChangeTargetPlan, 'product'> & {
  product: Omit<BillingPlanChangeTargetPlan['product'], 'level'> & { level: number | null };
};

export type PlanChangeQuoteFailureReason = 'TARGET_NOT_ALLOWED' | 'REQUEST_FAILED';

export type PlanChangeState = {
  open: boolean;
  phase: PlanChangePhase;
  planChange: BillingPlanChange | null;
  targetPlan: PlanChangeTargetSnapshot | null;
  error: boolean;
  quoteFailureReason: PlanChangeQuoteFailureReason | null;
  /**
   * True when the rendered change is a pre-request snapshot that could not be
   * re-read from the server (confirm and the recovery read both failed). A
   * stale quote must not be confirmable until a fresh read succeeds.
   */
  stale: boolean;
};

export type PlanChangeSettledKind = 'APPLIED' | 'CANCELED' | 'SCHEDULED' | 'FAILED' | 'EXPIRED';

const INITIAL_STATE: PlanChangeState = {
  open: false,
  phase: 'IDLE',
  planChange: null,
  targetPlan: null,
  error: false,
  quoteFailureReason: null,
  stale: false,
};

/**
 * Every phase is derived from the server status. Unknown statuses can never
 * reach here: the main-process projection rejects them, so the renderer only
 * sees the closed enum.
 */
function phaseForPlanChange(change: BillingPlanChange): PlanChangePhase {
  switch (change.status) {
    case 'QUOTED':
      return 'QUOTE_READY';
    case 'PENDING_PROVIDER':
      return 'PENDING_PROVIDER';
    case 'AWAITING_PAYMENT':
      return 'AWAITING_PAYMENT';
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'APPLIED':
      return 'APPLIED';
    case 'CANCELED':
      return 'CANCELED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'FAILED';
  }
}

function isSettledPhase(phase: PlanChangePhase): boolean {
  return (
    phase === 'APPLIED' ||
    phase === 'CANCELED' ||
    phase === 'FAILED' ||
    phase === 'EXPIRED' ||
    phase === 'SCHEDULED'
  );
}

function quoteFailureReason(error: unknown): PlanChangeQuoteFailureReason {
  return extractIpcError(error)?.code === 'PLAN_CHANGE_NOT_AVAILABLE'
    ? 'TARGET_NOT_ALLOWED'
    : 'REQUEST_FAILED';
}

export function usePlanChange(
  accountId: string | null,
  onSettled: (kind: PlanChangeSettledKind) => void,
) {
  const [state, setState] = useState<PlanChangeState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const settledNotifiedRef = useRef(new Set<string>());
  const onSettledRef = useRef(onSettled);
  stateRef.current = state;
  onSettledRef.current = onSettled;

  const persistIntent = useCallback(
    (intent: BillingPlanChangeIntentV1 | null) => {
      if (!accountId) return;
      try {
        if (intent) writeBillingPlanChangeIntent(accountId, intent);
        else clearBillingPlanChangeIntent(accountId);
      } catch {
        // Server projection still recovers state without local storage.
      }
    },
    [accountId],
  );

  const notifySettled = useCallback((change: BillingPlanChange) => {
    if (
      change.status !== 'APPLIED' &&
      change.status !== 'CANCELED' &&
      change.status !== 'SCHEDULED' &&
      change.status !== 'FAILED' &&
      change.status !== 'EXPIRED'
    )
      return;
    const settleKey = `${change.planChangeId}:${change.status}`;
    if (settledNotifiedRef.current.has(settleKey)) return;
    settledNotifiedRef.current.add(settleKey);
    onSettledRef.current(change.status);
  }, []);

  const applyChange = useCallback(
    (
      change: BillingPlanChange,
      options?: { targetPlan?: PlanChangeTargetSnapshot | null; open?: boolean },
    ) => {
      const phase = phaseForPlanChange(change);
      if (phase !== 'QUOTE_READY' && phase !== 'AWAITING_PAYMENT') {
        persistIntent(null);
      }
      notifySettled(change);
      if (!mountedRef.current) return;
      setState((current) => ({
        open: options?.open ?? current.open,
        phase,
        planChange: change,
        targetPlan: options?.targetPlan !== undefined ? options.targetPlan : current.targetPlan,
        error: false,
        quoteFailureReason: null,
        stale: false,
      }));
    },
    [notifySettled, persistIntent],
  );

  const withRequestLock = useCallback(async (request: () => Promise<void>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await request();
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  /** Adopt whatever the server says is open; never trust local state over it. */
  const adoptServerPending = useCallback(async (): Promise<boolean> => {
    try {
      const pending = (await billingApi.getCurrentSubscription()).subscription?.pendingPlanChange;
      if (!pending) return false;
      applyChange(pending, { targetPlan: pending.targetPlan, open: true });
      return true;
    } catch {
      return false;
    }
  }, [applyChange]);

  const startQuote = useCallback(
    async (targetOfferCode: string, targetPlan: PlanChangeTargetSnapshot | null) => {
      if (!accountId || inFlightRef.current) return;
      const previous = readBillingPlanChangeIntent(accountId);
      const intent: BillingPlanChangeIntentV1 =
        previous && previous.targetOfferCode === targetOfferCode && !previous.planChangeId
          ? previous
          : {
              version: 1,
              targetOfferCode,
              idempotencyKey: newBillingIdempotencyKey('plan-change'),
              planChangeId: null,
              createdAt: new Date().toISOString(),
            };
      persistIntent(intent);
      setState({
        open: true,
        phase: 'QUOTING',
        planChange: null,
        targetPlan,
        error: false,
        quoteFailureReason: null,
        stale: false,
      });
      await withRequestLock(async () => {
        try {
          const change = await billingApi.quotePlanChange(targetOfferCode, intent.idempotencyKey);
          persistIntent({ ...intent, planChangeId: change.planChangeId });
          applyChange(change, { targetPlan });
        } catch (error) {
          if (await adoptServerPending()) return;
          if (mountedRef.current) {
            setState((current) => ({
              ...current,
              phase: 'FAILED',
              error: true,
              quoteFailureReason: quoteFailureReason(error),
            }));
          }
        }
      });
    },
    [accountId, adoptServerPending, applyChange, persistIntent, withRequestLock],
  );

  const confirm = useCallback(async () => {
    const current = stateRef.current;
    if (!current.planChange || current.planChange.status !== 'QUOTED' || inFlightRef.current)
      return;
    const change = current.planChange;
    setState((value) => ({
      ...value,
      phase: 'CONFIRMING',
      error: false,
      quoteFailureReason: null,
    }));
    await withRequestLock(async () => {
      try {
        applyChange(await billingApi.confirmPlanChange(change.planChangeId));
      } catch {
        // The confirm may have landed server-side even though the response was
        // lost. Re-read the change before restoring anything local, so a
        // progressed change is never re-rendered as a confirmable quote.
        let latest: BillingPlanChange | null = null;
        try {
          latest = await billingApi.refreshPlanChange(change.planChangeId);
        } catch {
          // Fall back to the pre-request snapshot below.
        }
        if (!mountedRef.current) return;
        if (latest) {
          applyChange(latest);
          if (latest.status === change.status) {
            setState((value) => ({ ...value, error: true }));
          }
        } else {
          // Offline fallback: the snapshot may lag the server. Mark it stale so
          // the dialog swaps confirm for a resync action, and let the poll
          // effect keep retrying the read until connectivity returns.
          setState((value) => ({
            ...value,
            phase: phaseForPlanChange(change),
            error: true,
            stale: true,
          }));
        }
      }
    });
  }, [applyChange, withRequestLock]);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    if (!current.planChange) return;
    const planChangeId = current.planChange.planChangeId;
    await withRequestLock(async () => {
      try {
        applyChange(await billingApi.refreshPlanChange(planChangeId));
      } catch {
        if (mountedRef.current) setState((value) => ({ ...value, error: true }));
      }
    });
  }, [applyChange, withRequestLock]);

  /** Cancels a quoted change or a scheduled downgrade (撤销). */
  const cancelChange = useCallback(
    async (planChangeId: string) => {
      if (inFlightRef.current) return;
      await withRequestLock(async () => {
        try {
          applyChange(await billingApi.cancelPlanChange(planChangeId));
        } catch {
          if (mountedRef.current) setState((value) => ({ ...value, error: true }));
        }
      });
    },
    [applyChange, withRequestLock],
  );

  /** Re-enter a server-reported open change (e.g. resume an alipay QR). */
  const resumePending = useCallback(
    (pending: BillingPendingPlanChange) => {
      applyChange(pending, { targetPlan: pending.targetPlan, open: true });
    },
    [applyChange],
  );

  const close = useCallback(() => {
    setState((current) =>
      current.phase === 'QUOTING' || current.phase === 'CONFIRMING'
        ? current
        : { ...current, open: false },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    settledNotifiedRef.current = new Set();
    setState(INITIAL_STATE);
    if (!accountId) {
      return () => {
        mountedRef.current = false;
      };
    }
    const intent = readBillingPlanChangeIntent(accountId);
    if (intent?.planChangeId) {
      const planChangeId = intent.planChangeId;
      void withRequestLock(async () => {
        try {
          const change = await billingApi.refreshPlanChange(planChangeId);
          if (!mountedRef.current) return;
          const phase = phaseForPlanChange(change);
          applyChange(change, {
            // The catalog-side target label is rebuilt from the server pending
            // projection when present; a bare refresh keeps it unknown.
            targetPlan: null,
            open:
              phase === 'AWAITING_PAYMENT' ||
              phase === 'PENDING_PROVIDER' ||
              phase === 'QUOTE_READY',
          });
          if (isSettledPhase(phase)) persistIntent(null);
        } catch {
          // The pendingPlanChange banner remains the recovery entry point.
        }
      });
    } else if (intent) {
      // The quote request never resolved locally. If it landed server-side the
      // pendingPlanChange projection will surface it; the stored key alone must
      // not trigger a new quote on startup.
      persistIntent(null);
    }
    return () => {
      mountedRef.current = false;
    };
  }, [accountId, applyChange, persistIntent, withRequestLock]);

  useEffect(() => {
    // Poll while waiting for a payment, and also while showing a stale
    // snapshot so the dialog resynchronizes on its own once the server is
    // reachable again.
    if (
      !state.open ||
      (state.phase !== 'AWAITING_PAYMENT' && state.phase !== 'PENDING_PROVIDER' && !state.stale)
    )
      return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, state.open, state.phase, state.stale]);

  return {
    state,
    startQuote,
    confirm,
    refresh,
    cancelChange,
    resumePending,
    close,
  };
}

export { phaseForPlanChange };
