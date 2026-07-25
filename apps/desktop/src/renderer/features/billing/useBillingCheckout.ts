import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BillingPaymentOrder,
  BillingSubscription,
  CreateBillingSubscriptionRequest,
  CreateBillingTopupRequest,
} from '../../../shared/billing';
import { billingApi } from './api';
import { clearLegacyBillingIntentStorage, newBillingIdempotencyKey } from './checkoutIntent';

export type BillingCheckoutPhase =
  'IDLE' | 'CREATING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELED';

/**
 * In-memory only. A checkout session belongs to the open dialog: closing it
 * discards the intent, and the next selection generates a fresh idempotency
 * key. The server verifies and replaces any stale payment action on create.
 */
export type BillingCheckoutIntent =
  | { kind: 'TOPUP'; idempotencyKey: string; request: CreateBillingTopupRequest }
  | { kind: 'SUBSCRIPTION'; idempotencyKey: string; request: CreateBillingSubscriptionRequest }
  | { kind: 'TOPUP_RETRY'; idempotencyKey: string; orderId: string };

export type BillingCheckoutState = {
  open: boolean;
  kind: 'TOPUP' | 'SUBSCRIPTION' | null;
  phase: BillingCheckoutPhase;
  intent: BillingCheckoutIntent | null;
  order: BillingPaymentOrder | null;
  subscription: BillingSubscription | null;
  error: boolean;
};

const INITIAL_STATE: BillingCheckoutState = {
  open: false,
  kind: null,
  phase: 'IDLE',
  intent: null,
  order: null,
  subscription: null,
  error: false,
};

function phaseForOrder(order: BillingPaymentOrder): BillingCheckoutPhase {
  if (order.status === 'FAILED') return 'FAILED';
  if (order.status === 'EXPIRED') return 'EXPIRED';
  if (order.status === 'CANCELED') return 'CANCELED';
  if (order.status === 'SUCCEEDED') return 'COMPLETED';
  return 'AWAITING_PAYMENT';
}

function phaseForSubscription(subscription: BillingSubscription): BillingCheckoutPhase {
  if (subscription.status === 'INCOMPLETE') return 'AWAITING_PAYMENT';
  if (subscription.status === 'INCOMPLETE_EXPIRED') return 'EXPIRED';
  if (subscription.status === 'CANCELED') return 'CANCELED';
  if (subscription.status === 'TRIALING' || subscription.status === 'ACTIVE') return 'COMPLETED';
  return 'FAILED';
}

export function useBillingCheckout(accountId: string | null) {
  const [state, setState] = useState<BillingCheckoutState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  stateRef.current = state;

  const applyOrder = useCallback((order: BillingPaymentOrder, intent: BillingCheckoutIntent | null) => {
    if (!mountedRef.current) return;
    setState({
      open: true,
      kind: 'TOPUP',
      phase: phaseForOrder(order),
      intent,
      order,
      subscription: null,
      error: false,
    });
  }, []);

  const applySubscription = useCallback(
    (subscription: BillingSubscription, intent: BillingCheckoutIntent | null) => {
      if (!mountedRef.current) return;
      setState({
        open: true,
        kind: 'SUBSCRIPTION',
        phase: phaseForSubscription(subscription),
        intent,
        order: null,
        subscription,
        error: false,
      });
    },
    [],
  );

  const failCurrentOperation = useCallback(() => {
    if (!mountedRef.current) return;
    setState((current) => ({ ...current, phase: 'FAILED', error: true }));
  }, []);

  const withRequestLock = useCallback(async (request: () => Promise<void>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await request();
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const startTopup = useCallback(
    async (request: CreateBillingTopupRequest) => {
      if (!accountId || inFlightRef.current) return;
      const intent: BillingCheckoutIntent = {
        kind: 'TOPUP',
        idempotencyKey: newBillingIdempotencyKey('topup'),
        request,
      };
      setState({
        open: true,
        kind: 'TOPUP',
        phase: 'CREATING',
        intent,
        order: null,
        subscription: null,
        error: false,
      });
      await withRequestLock(async () => {
        try {
          applyOrder(await billingApi.createTopup(request, intent.idempotencyKey), intent);
        } catch {
          failCurrentOperation();
        }
      });
    },
    [accountId, applyOrder, failCurrentOperation, withRequestLock],
  );

  const startSubscription = useCallback(
    async (request: CreateBillingSubscriptionRequest) => {
      if (!accountId || inFlightRef.current) return;
      const intent: BillingCheckoutIntent = {
        kind: 'SUBSCRIPTION',
        idempotencyKey: newBillingIdempotencyKey('subscription'),
        request,
      };
      setState({
        open: true,
        kind: 'SUBSCRIPTION',
        phase: 'CREATING',
        intent,
        order: null,
        subscription: null,
        error: false,
      });
      await withRequestLock(async () => {
        try {
          applySubscription(
            await billingApi.createSubscription(request, intent.idempotencyKey),
            intent,
          );
        } catch {
          failCurrentOperation();
        }
      });
    },
    [accountId, applySubscription, failCurrentOperation, withRequestLock],
  );

  const refreshActive = useCallback(async () => {
    await withRequestLock(async () => {
      const current = stateRef.current;
      try {
        if (current.kind === 'TOPUP' && current.order) {
          const order =
            current.phase === 'AWAITING_PAYMENT'
              ? await billingApi.refreshTopup(current.order.orderId)
              : await billingApi.getOrder(current.order.orderId);
          applyOrder(order, current.intent);
          return;
        }
        if (current.kind === 'SUBSCRIPTION' && current.subscription?.purchaseAttemptId) {
          applySubscription(
            await billingApi.refreshSubscriptionPurchase(current.subscription.purchaseAttemptId),
            current.intent,
          );
        }
      } catch {
        if (mountedRef.current) setState((value) => ({ ...value, error: true }));
      }
    });
  }, [applyOrder, applySubscription, withRequestLock]);

  const retry = useCallback(async () => {
    if (inFlightRef.current) return;
    const current = stateRef.current;
    if (current.error && current.intent?.kind === 'TOPUP_RETRY') {
      await startTopupRetryWithIntent(current.intent);
      return;
    }
    if (current.kind === 'TOPUP' && current.order) {
      await startTopupRetryWithIntent({
        kind: 'TOPUP_RETRY',
        idempotencyKey: newBillingIdempotencyKey('retry'),
        orderId: current.order.orderId,
      });
      return;
    }
    // Create request failed before any business object existed: replay the
    // same in-memory intent (same idempotency key) once more.
    if (current.intent?.kind === 'TOPUP' && !current.order) {
      const intent = current.intent;
      setState((value) => ({ ...value, phase: 'CREATING', error: false }));
      await withRequestLock(async () => {
        try {
          applyOrder(await billingApi.createTopup(intent.request, intent.idempotencyKey), intent);
        } catch {
          failCurrentOperation();
        }
      });
      return;
    }
    if (current.intent?.kind === 'SUBSCRIPTION' && !current.subscription) {
      const intent = current.intent;
      setState((value) => ({ ...value, phase: 'CREATING', error: false }));
      await withRequestLock(async () => {
        try {
          applySubscription(
            await billingApi.createSubscription(intent.request, intent.idempotencyKey),
            intent,
          );
        } catch {
          failCurrentOperation();
        }
      });
    }
  }, [applyOrder, applySubscription, failCurrentOperation, withRequestLock]);

  async function startTopupRetryWithIntent(
    intent: Extract<BillingCheckoutIntent, { kind: 'TOPUP_RETRY' }>,
  ) {
    const previousOrder =
      stateRef.current.order?.orderId === intent.orderId ? stateRef.current.order : null;
    setState({
      open: true,
      kind: 'TOPUP',
      phase: 'CREATING',
      intent,
      order: previousOrder,
      subscription: null,
      error: false,
    });
    await withRequestLock(async () => {
      try {
        applyOrder(await billingApi.retryTopup(intent.orderId, intent.idempotencyKey), intent);
      } catch {
        failCurrentOperation();
      }
    });
  }

  const cancel = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== 'TOPUP' || !current.order) return;
    await withRequestLock(async () => {
      try {
        applyOrder(await billingApi.cancelTopup(current.order!.orderId), current.intent);
      } catch {
        if (mountedRef.current) setState((value) => ({ ...value, error: true }));
      }
    });
  }, [applyOrder, withRequestLock]);

  // Closing the dialog ends the checkout session entirely; reopening the
  // purchase flow starts over with a new idempotency key.
  const close = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setState(INITIAL_STATE);
    clearLegacyBillingIntentStorage(accountId);
    return () => {
      mountedRef.current = false;
    };
  }, [accountId]);

  useEffect(() => {
    const shouldPoll = state.open && state.phase === 'AWAITING_PAYMENT';
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshActive();
    }, 3_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshActive();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshActive, state.open, state.phase]);

  return {
    state,
    startTopup,
    startSubscription,
    refreshActive,
    retry,
    cancel,
    close,
  };
}

export { phaseForOrder, phaseForSubscription };
