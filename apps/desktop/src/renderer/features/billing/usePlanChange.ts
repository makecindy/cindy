import { useCallback, useEffect, useRef, useState } from 'react';

import { extractIpcError } from '@/utils/ipcError';
import type {
  BillingPlanChange,
  BillingPlanChangeTargetPlan,
} from '../../../shared/billing';
import { billingApi } from './api';
import { newBillingIdempotencyKey } from './checkoutIntent';

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
  // 会话代次：切换账号或重新挂载后，旧账号/旧会话的迟到响应不得覆盖新状态。
  const sessionRef = useRef(0);
  // 请求锁按会话持有：旧会话的在途刷新不阻断新目标的重新报价，
  // 且旧请求结束时不会误释放新会话已持有的锁。
  const inFlightRef = useRef<number | null>(null);
  const settledNotifiedRef = useRef(new Set<string>());
  const onSettledRef = useRef(onSettled);
  stateRef.current = state;
  onSettledRef.current = onSettled;

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
      session: number,
      options?: { targetPlan?: PlanChangeTargetSnapshot | null; open?: boolean },
    ) => {
      if (!mountedRef.current || session !== sessionRef.current) return;
      notifySettled(change);
      setState((current) => ({
        open: options?.open ?? current.open,
        phase: phaseForPlanChange(change),
        planChange: change,
        targetPlan: options?.targetPlan !== undefined ? options.targetPlan : current.targetPlan,
        error: false,
        quoteFailureReason: null,
        stale: false,
      }));
    },
    [notifySettled],
  );

  const withRequestLock = useCallback(async (session: number, request: () => Promise<void>) => {
    if (inFlightRef.current === session) return;
    inFlightRef.current = session;
    try {
      await request();
    } finally {
      if (inFlightRef.current === session) inFlightRef.current = null;
    }
  }, []);

  const startQuote = useCallback(
    async (targetOfferCode: string, targetPlan: PlanChangeTargetSnapshot | null) => {
      if (!accountId || inFlightRef.current === sessionRef.current) return;
      // 每次重新选择目标都是新的结算会话：新代次 + 新幂等键，旧会话在途响应作废，
      // 服务端自动撤销旧未完成变更。
      const session = ++sessionRef.current;
      const idempotencyKey = newBillingIdempotencyKey('plan-change');
      setState({
        open: true,
        phase: 'QUOTING',
        planChange: null,
        targetPlan,
        error: false,
        quoteFailureReason: null,
        stale: false,
      });
      await withRequestLock(session, async () => {
        try {
          applyChange(await billingApi.quotePlanChange(targetOfferCode, idempotencyKey), session, {
            targetPlan,
          });
        } catch (error) {
          if (mountedRef.current && session === sessionRef.current) {
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
    [accountId, applyChange, withRequestLock],
  );

  const confirm = useCallback(async () => {
    const current = stateRef.current;
    if (
      !current.planChange ||
      current.planChange.status !== 'QUOTED' ||
      inFlightRef.current === sessionRef.current
    )
      return;
    const change = current.planChange;
    const session = sessionRef.current;
    setState((value) => ({
      ...value,
      phase: 'CONFIRMING',
      error: false,
      quoteFailureReason: null,
    }));
    await withRequestLock(session, async () => {
      try {
        applyChange(await billingApi.confirmPlanChange(change.planChangeId), session);
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
        if (!mountedRef.current || session !== sessionRef.current) return;
        if (latest) {
          applyChange(latest, session);
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

  const refresh = useCallback(async (expectedSession = sessionRef.current) => {
    if (expectedSession !== sessionRef.current) return;
    const current = stateRef.current;
    if (!current.planChange) return;
    const planChangeId = current.planChange.planChangeId;
    const session = expectedSession;
    await withRequestLock(session, async () => {
      if (session !== sessionRef.current) return;
      try {
        applyChange(await billingApi.refreshPlanChange(planChangeId), session);
      } catch {
        if (mountedRef.current && session === sessionRef.current) {
          setState((value) => ({ ...value, error: true }));
        }
      }
    });
  }, [applyChange, withRequestLock]);

  /** Cancels a quoted change or a scheduled downgrade (撤销). */
  const cancelChange = useCallback(
    async (planChangeId: string) => {
      if (inFlightRef.current === sessionRef.current) return;
      const session = sessionRef.current;
      await withRequestLock(session, async () => {
        try {
          applyChange(await billingApi.cancelPlanChange(planChangeId), session);
        } catch {
          if (mountedRef.current && session === sessionRef.current) {
            setState((value) => ({ ...value, error: true }));
          }
        }
      });
    },
    [applyChange, withRequestLock],
  );

  const close = useCallback(() => {
    const current = stateRef.current;
    if (current.phase === 'QUOTING' || current.phase === 'CONFIRMING') return;
    sessionRef.current += 1;
    inFlightRef.current = null;
    const next = { ...current, open: false };
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    // 套餐变更会话只属于当前打开的 Dialog：切换账号或重新挂载都从空状态开始，
    // 不从本地存储或服务端恢复历史二维码。
    mountedRef.current = true;
    sessionRef.current += 1;
    inFlightRef.current = null;
    settledNotifiedRef.current = new Set();
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
    return () => {
      mountedRef.current = false;
    };
  }, [accountId]);

  useEffect(() => {
    // Poll while waiting for a payment, and also while showing a stale
    // snapshot so the dialog resynchronizes on its own once the server is
    // reachable again.
    if (
      !state.open ||
      (state.phase !== 'AWAITING_PAYMENT' && state.phase !== 'PENDING_PROVIDER' && !state.stale)
    )
      return;
    const session = sessionRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(session);
    }, 3_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh(session);
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
    close,
  };
}

export { phaseForPlanChange };
