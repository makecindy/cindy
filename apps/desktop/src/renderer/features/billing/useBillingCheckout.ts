import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BillingPaymentOrder,
  BillingSubscription,
  CreateBillingSubscriptionRequest,
  CreateBillingTopupRequest,
} from '../../../shared/billing';
import { billingApi } from './api';
import {
  clearBillingCheckoutIntent,
  newBillingIdempotencyKey,
  readBillingCheckoutIntent,
  writeBillingCheckoutIntent,
  type BillingCheckoutIntentV1,
} from './checkoutIntent';

export type BillingCheckoutPhase =
  | 'IDLE'
  | 'CREATING'
  | 'AWAITING_PAYMENT'
  | 'FULFILLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELED';

export type BillingCheckoutState = {
  open: boolean;
  kind: 'TOPUP' | 'SUBSCRIPTION' | null;
  phase: BillingCheckoutPhase;
  intent: BillingCheckoutIntentV1 | null;
  order: BillingPaymentOrder | null;
  subscription: BillingSubscription | null;
  error: boolean;
};

export type BillingRecoverables = {
  topups: BillingPaymentOrder[];
  subscription: BillingSubscription | null;
};

type CheckoutPresentation = 'VISIBLE' | 'BACKGROUND';

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
  if (order.status === 'SUCCEEDED') {
    return order.fulfillmentStatus === 'SUCCEEDED' ? 'COMPLETED' : 'FULFILLING';
  }
  return 'AWAITING_PAYMENT';
}

function phaseForSubscription(subscription: BillingSubscription): BillingCheckoutPhase {
  if (subscription.status === 'INCOMPLETE') return 'AWAITING_PAYMENT';
  if (subscription.status === 'INCOMPLETE_EXPIRED') return 'EXPIRED';
  if (subscription.status === 'CANCELED') return 'CANCELED';
  if (subscription.status === 'TRIALING' || subscription.status === 'ACTIVE') return 'COMPLETED';
  return 'FAILED';
}

function isTerminal(phase: BillingCheckoutPhase): boolean {
  return ['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELED'].includes(phase);
}

function isRecoverableTopup(value: {
  status: string;
  fulfillmentStatus?: string;
  paymentAction: { expiresAt: string } | null;
}): boolean {
  return (
    value.status === 'CREATED' ||
    value.status === 'PENDING' ||
    (value.status === 'SUCCEEDED' && value.fulfillmentStatus !== 'SUCCEEDED')
  );
}

function persistIntent(accountId: string | null, intent: BillingCheckoutIntentV1 | null): void {
  if (!accountId) return;
  try {
    if (intent) writeBillingCheckoutIntent(accountId, intent);
    else clearBillingCheckoutIntent(accountId);
  } catch {
    // Server recovery remains available when browser storage is unavailable.
  }
}

function matchesSubscriptionIntent(
  subscription: BillingSubscription,
  intent: Extract<BillingCheckoutIntentV1, { kind: 'SUBSCRIPTION' }>,
): boolean {
  if (intent.subscriptionId && subscription.subscriptionId !== intent.subscriptionId) return false;
  if (intent.purchaseAttemptId && subscription.purchaseAttemptId !== intent.purchaseAttemptId) {
    const terminalSameSubscription =
      intent.subscriptionId !== null &&
      subscription.subscriptionId === intent.subscriptionId &&
      subscription.status !== 'INCOMPLETE' &&
      subscription.purchaseAttemptId === null;
    if (!terminalSameSubscription) return false;
  }
  return true;
}

export function useBillingCheckout(accountId: string | null) {
  const [state, setState] = useState<BillingCheckoutState>(INITIAL_STATE);
  const [recoverables, setRecoverables] = useState<BillingRecoverables>({
    topups: [],
    subscription: null,
  });
  const [recovering, setRecovering] = useState(true);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  stateRef.current = state;

  const applyOrder = useCallback(
    (
      order: BillingPaymentOrder,
      intent: BillingCheckoutIntentV1 | null,
      presentation: CheckoutPresentation = 'VISIBLE',
    ) => {
      const nextIntent =
        intent?.kind === 'TOPUP' && intent.orderId !== order.orderId
          ? { ...intent, orderId: order.orderId }
          : intent;
      const phase = phaseForOrder(order);
      if (nextIntent && !isTerminal(phase)) persistIntent(accountId, nextIntent);
      if (isTerminal(phase)) persistIntent(accountId, null);
      if (!mountedRef.current) return;
      setRecoverables((current) => ({
        ...current,
        topups: isRecoverableTopup(order)
          ? [order, ...current.topups.filter((item) => item.orderId !== order.orderId)]
          : current.topups.filter((item) => item.orderId !== order.orderId),
      }));
      setState({
        open: presentation === 'VISIBLE',
        kind: 'TOPUP',
        phase,
        intent: nextIntent,
        order,
        subscription: null,
        error: false,
      });
    },
    [accountId],
  );

  const applySubscription = useCallback(
    (
      subscription: BillingSubscription,
      intent: BillingCheckoutIntentV1 | null,
      presentation: CheckoutPresentation = 'VISIBLE',
    ) => {
      if (intent?.kind === 'SUBSCRIPTION' && !matchesSubscriptionIntent(subscription, intent))
        return false;
      const nextIntent =
        intent?.kind === 'SUBSCRIPTION'
          ? {
              ...intent,
              subscriptionId: subscription.subscriptionId,
              purchaseAttemptId: subscription.purchaseAttemptId,
            }
          : intent;
      const phase = phaseForSubscription(subscription);
      if (nextIntent && !isTerminal(phase)) persistIntent(accountId, nextIntent);
      if (isTerminal(phase)) persistIntent(accountId, null);
      if (!mountedRef.current) return true;
      setRecoverables((current) => ({
        ...current,
        subscription: subscription.status === 'INCOMPLETE' ? subscription : null,
      }));
      setState({
        open: presentation === 'VISIBLE',
        kind: 'SUBSCRIPTION',
        phase,
        intent: nextIntent,
        order: null,
        subscription,
        error: false,
      });
      return true;
    },
    [accountId],
  );

  const failCurrentOperation = useCallback((presentation: CheckoutPresentation = 'VISIBLE') => {
    if (!mountedRef.current) return;
    setState((current) => ({
      ...current,
      open: presentation === 'VISIBLE',
      phase: 'FAILED',
      error: true,
    }));
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
      const intent: BillingCheckoutIntentV1 = {
        version: 1,
        kind: 'TOPUP',
        idempotencyKey: newBillingIdempotencyKey('topup'),
        request,
        orderId: null,
        createdAt: new Date().toISOString(),
      };
      persistIntent(accountId, intent);
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

  const recoverPendingSubscription = useCallback(
    async (intent: Extract<BillingCheckoutIntentV1, { kind: 'SUBSCRIPTION' }>) => {
      if (!intent.subscriptionId && !intent.purchaseAttemptId) return false;
      try {
        const current = (await billingApi.getCurrentSubscription()).subscription;
        if (current?.status !== 'INCOMPLETE') return false;
        return applySubscription(current, intent);
      } catch {
        return false;
      }
    },
    [applySubscription],
  );

  const startSubscription = useCallback(
    async (request: CreateBillingSubscriptionRequest) => {
      if (!accountId || inFlightRef.current) return;
      const intent: BillingCheckoutIntentV1 = {
        version: 1,
        kind: 'SUBSCRIPTION',
        idempotencyKey: newBillingIdempotencyKey('subscription'),
        request,
        subscriptionId: null,
        purchaseAttemptId: null,
        createdAt: new Date().toISOString(),
      };
      persistIntent(accountId, intent);
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
          if (!(await recoverPendingSubscription(intent))) failCurrentOperation();
        }
      });
    },
    [
      accountId,
      applySubscription,
      failCurrentOperation,
      recoverPendingSubscription,
      withRequestLock,
    ],
  );

  const refreshActive = useCallback(async () => {
    await withRequestLock(async () => {
      const current = stateRef.current;
      const presentation: CheckoutPresentation = current.open ? 'VISIBLE' : 'BACKGROUND';
      try {
        if (current.kind === 'TOPUP' && current.order) {
          const order =
            current.phase === 'AWAITING_PAYMENT'
              ? await billingApi.refreshTopup(current.order.orderId)
              : await billingApi.getOrder(current.order.orderId);
          applyOrder(order, current.intent, presentation);
          return;
        }
        if (current.kind === 'SUBSCRIPTION' && current.subscription) {
          const subscription =
            current.phase === 'AWAITING_PAYMENT' && current.subscription.purchaseAttemptId
              ? await billingApi.refreshSubscriptionPurchase(current.subscription.purchaseAttemptId)
              : (await billingApi.getCurrentSubscription()).subscription;
          if (subscription && !applySubscription(subscription, current.intent, presentation)) {
            failCurrentOperation(presentation);
          }
        }
      } catch {
        if (mountedRef.current) setState((value) => ({ ...value, error: true }));
      }
    });
  }, [applyOrder, applySubscription, failCurrentOperation, withRequestLock]);

  const retry = useCallback(async () => {
    if (inFlightRef.current) return;
    const current = stateRef.current;
    if (current.error && current.intent?.kind === 'TOPUP_RETRY') {
      await startTopupRetryWithIntent(current.intent);
      return;
    }
    if (current.kind === 'TOPUP' && current.order) {
      const intent: Extract<BillingCheckoutIntentV1, { kind: 'TOPUP_RETRY' }> = {
        version: 1,
        kind: 'TOPUP_RETRY',
        idempotencyKey: newBillingIdempotencyKey('retry'),
        orderId: current.order.orderId,
        createdAt: new Date().toISOString(),
      };
      persistIntent(accountId, intent);
      await startTopupRetryWithIntent(intent);
      return;
    }
    if (current.intent && !current.order && !current.subscription) {
      if (current.intent.kind === 'TOPUP') {
        await startTopupWithIntent(current.intent);
      } else if (current.intent.kind === 'SUBSCRIPTION') {
        await startSubscriptionWithIntent(current.intent);
      } else {
        await startTopupRetryWithIntent(current.intent);
      }
    }
  }, [accountId, applyOrder, failCurrentOperation, withRequestLock]);

  async function startTopupWithIntent(intent: Extract<BillingCheckoutIntentV1, { kind: 'TOPUP' }>) {
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
        const order = intent.orderId
          ? await billingApi.getOrder(intent.orderId)
          : await billingApi.createTopup(intent.request, intent.idempotencyKey);
        applyOrder(order, intent);
      } catch {
        failCurrentOperation();
      }
    });
  }

  async function startSubscriptionWithIntent(
    intent: Extract<BillingCheckoutIntentV1, { kind: 'SUBSCRIPTION' }>,
  ) {
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
        const subscription = intent.purchaseAttemptId
          ? await billingApi.refreshSubscriptionPurchase(intent.purchaseAttemptId)
          : intent.subscriptionId
            ? (await billingApi.getCurrentSubscription()).subscription
            : await billingApi.createSubscription(intent.request, intent.idempotencyKey);
        if (!subscription || !applySubscription(subscription, intent)) failCurrentOperation();
      } catch {
        if (!(await recoverPendingSubscription(intent))) failCurrentOperation();
      }
    });
  }

  async function startTopupRetryWithIntent(
    intent: Extract<BillingCheckoutIntentV1, { kind: 'TOPUP_RETRY' }>,
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

  const close = useCallback(() => {
    setState((current) => ({ ...current, open: false }));
  }, []);

  const resumeTopup = useCallback(
    (order: BillingPaymentOrder) => {
      applyOrder(order, null);
    },
    [applyOrder],
  );

  const resumeSubscription = useCallback(
    (subscription: BillingSubscription) => {
      applySubscription(subscription, null);
    },
    [applySubscription],
  );

  const resumeFailed = useCallback(() => {
    setState((current) => {
      if (
        current.open ||
        current.phase !== 'FAILED' ||
        !current.error ||
        !current.intent ||
        current.order ||
        current.subscription
      ) {
        return current;
      }
      return { ...current, open: true };
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!accountId) {
      setState(INITIAL_STATE);
      setRecoverables({ topups: [], subscription: null });
      setRecovering(false);
      return () => {
        mountedRef.current = false;
      };
    }
    const restore = async () => {
      const intent = readBillingCheckoutIntent(accountId);
      inFlightRef.current = true;
      try {
        const [ordersResult, subscriptionResult] = await Promise.allSettled([
          billingApi.listOrders(),
          billingApi.getCurrentSubscription(),
        ]);
        if (!mountedRef.current) return;
        setRecoverables({
          topups:
            ordersResult.status === 'fulfilled'
              ? ordersResult.value.orders.filter(isRecoverableTopup)
              : [],
          subscription:
            subscriptionResult.status === 'fulfilled' &&
            subscriptionResult.value.subscription?.status === 'INCOMPLETE'
              ? subscriptionResult.value.subscription
              : null,
        });

        if (!intent) return;
        setState({
          open: false,
          kind: intent.kind === 'SUBSCRIPTION' ? 'SUBSCRIPTION' : 'TOPUP',
          phase: 'CREATING',
          intent,
          order: null,
          subscription: null,
          error: false,
        });
        try {
          if (intent.kind === 'TOPUP') {
            const listedOrder =
              intent.orderId && ordersResult.status === 'fulfilled'
                ? ordersResult.value.orders.find((order) => order.orderId === intent.orderId)
                : null;
            const order =
              listedOrder ??
              (intent.orderId
                ? await billingApi.getOrder(intent.orderId)
                : await billingApi.createTopup(intent.request, intent.idempotencyKey));
            applyOrder(order, intent, 'BACKGROUND');
            return;
          }

          if (intent.kind === 'TOPUP_RETRY') {
            applyOrder(
              await billingApi.retryTopup(intent.orderId, intent.idempotencyKey),
              intent,
              'BACKGROUND',
            );
            return;
          }

          if (
            intent.subscriptionId &&
            !intent.purchaseAttemptId &&
            subscriptionResult.status === 'rejected'
          ) {
            failCurrentOperation('BACKGROUND');
            return;
          }
          const currentSubscription =
            subscriptionResult.status === 'fulfilled'
              ? subscriptionResult.value.subscription
              : null;
          const subscription = intent.purchaseAttemptId
            ? await billingApi.refreshSubscriptionPurchase(intent.purchaseAttemptId)
            : intent.subscriptionId
              ? currentSubscription
              : await billingApi.createSubscription(intent.request, intent.idempotencyKey);
          if (!subscription || !applySubscription(subscription, intent, 'BACKGROUND')) {
            failCurrentOperation('BACKGROUND');
          }
        } catch {
          failCurrentOperation('BACKGROUND');
        }
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setRecovering(false);
      }
    };
    void restore();
    return () => {
      mountedRef.current = false;
    };
  }, [accountId, applyOrder, applySubscription, failCurrentOperation]);

  useEffect(() => {
    const shouldPoll =
      state.phase === 'FULFILLING' || (state.open && state.phase === 'AWAITING_PAYMENT');
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
    recoverables,
    recovering,
    startTopup,
    startSubscription,
    refreshActive,
    retry,
    cancel,
    close,
    resumeTopup,
    resumeSubscription,
    resumeFailed,
  };
}

export { isRecoverableTopup, phaseForOrder, phaseForSubscription };
