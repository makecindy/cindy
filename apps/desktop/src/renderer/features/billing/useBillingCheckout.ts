import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BillingPaymentOrder,
  BillingSubscription,
  CreateBillingGiftCardOrderRequest,
  CreateBillingSubscriptionRequest,
  CreateBillingTopupRequest,
} from '../../../shared/billing';
import { extractIpcError } from '@/utils/ipcError';
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
  | {
      kind: 'GIFT_CARD';
      idempotencyKey: string;
      request: CreateBillingGiftCardOrderRequest;
      /** 单张面额，供支付弹窗写「礼品卡 ¥100 × 2」。 */
      unitAmount: string;
    }
  | { kind: 'SUBSCRIPTION'; idempotencyKey: string; request: CreateBillingSubscriptionRequest }
  | { kind: 'TOPUP_RETRY'; idempotencyKey: string; orderId: string };

/** 创建订单时服务端明确拒绝的原因；其它失败（网络、5xx）统一按请求失败说明。 */
export type BillingCheckoutFailure = 'GIFT_CARD_LIMIT_REACHED' | 'GIFT_CARD_AMOUNT_TOO_LARGE';

export type BillingCheckoutState = {
  open: boolean;
  /** TOPUP 是一次性订单（充值或礼品卡，见 isGiftCardCheckout）；SUBSCRIPTION 是订阅首购。 */
  kind: 'TOPUP' | 'SUBSCRIPTION' | null;
  phase: BillingCheckoutPhase;
  intent: BillingCheckoutIntent | null;
  order: BillingPaymentOrder | null;
  subscription: BillingSubscription | null;
  error: boolean;
  failure: BillingCheckoutFailure | null;
};

const INITIAL_STATE: BillingCheckoutState = {
  open: false,
  kind: null,
  phase: 'IDLE',
  intent: null,
  order: null,
  subscription: null,
  error: false,
  failure: null,
};

/** 这次结算买的是礼品卡：重试后的新订单仍带着同一个礼品卡意图。 */
export function isGiftCardCheckout(state: BillingCheckoutState): boolean {
  return state.order?.productKind === 'GIFT_CARD' || state.intent?.kind === 'GIFT_CARD';
}

function failureOf(error: unknown): BillingCheckoutFailure | null {
  const code = extractIpcError(error)?.code;
  if (code === 'GIFT_CARD_PURCHASE_LIMIT_REACHED') return 'GIFT_CARD_LIMIT_REACHED';
  if (code === 'GIFT_CARD_ORDER_AMOUNT_TOO_LARGE') return 'GIFT_CARD_AMOUNT_TOO_LARGE';
  return null;
}

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
  // 会话代次：close/切换账号使当前会话失效，迟到的异步响应不得重开已结束的会话。
  const sessionRef = useRef(0);
  // 请求锁按会话持有：记录在途请求所属代次。旧会话的在途请求不阻断新会话发起，
  // 且其结束时不会误释放新会话已持有的锁。
  const inFlightRef = useRef<number | null>(null);
  stateRef.current = state;

  const applyOrder = useCallback(
    (order: BillingPaymentOrder, intent: BillingCheckoutIntent | null, session: number) => {
      if (!mountedRef.current || session !== sessionRef.current) return;
      setState({
        open: true,
        kind: 'TOPUP',
        phase: phaseForOrder(order),
        intent,
        order,
        subscription: null,
        error: false,
        failure: null,
      });
    },
    [],
  );

  const applySubscription = useCallback(
    (subscription: BillingSubscription, intent: BillingCheckoutIntent | null, session: number) => {
      if (!mountedRef.current || session !== sessionRef.current) return;
      setState({
        open: true,
        kind: 'SUBSCRIPTION',
        phase: phaseForSubscription(subscription),
        intent,
        order: null,
        subscription,
        error: false,
        failure: null,
      });
    },
    [],
  );

  const failCurrentOperation = useCallback((session: number, error?: unknown) => {
    if (!mountedRef.current || session !== sessionRef.current) return;
    const failure = failureOf(error);
    setState((current) => ({ ...current, phase: 'FAILED', error: true, failure }));
  }, []);

  const flagError = useCallback((session: number) => {
    if (!mountedRef.current || session !== sessionRef.current) return;
    setState((value) => ({ ...value, error: true }));
  }, []);

  const withRequestLock = useCallback(async (session: number, request: () => Promise<void>) => {
    if (inFlightRef.current === session) return;
    inFlightRef.current = session;
    try {
      await request();
    } finally {
      if (inFlightRef.current === session) inFlightRef.current = null;
    }
  }, []);

  const startTopup = useCallback(
    async (request: CreateBillingTopupRequest) => {
      if (!accountId || inFlightRef.current === sessionRef.current) return;
      const session = ++sessionRef.current;
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
        failure: null,
      });
      await withRequestLock(session, async () => {
        try {
          applyOrder(await billingApi.createTopup(request, intent.idempotencyKey), intent, session);
        } catch {
          failCurrentOperation(session);
        }
      });
    },
    [accountId, applyOrder, failCurrentOperation, withRequestLock],
  );

  const startGiftCard = useCallback(
    async (request: CreateBillingGiftCardOrderRequest, unitAmount: string) => {
      if (!accountId || inFlightRef.current === sessionRef.current) return;
      const session = ++sessionRef.current;
      const intent: BillingCheckoutIntent = {
        kind: 'GIFT_CARD',
        idempotencyKey: newBillingIdempotencyKey('gift-card'),
        request,
        unitAmount,
      };
      setState({
        open: true,
        kind: 'TOPUP',
        phase: 'CREATING',
        intent,
        order: null,
        subscription: null,
        error: false,
        failure: null,
      });
      await withRequestLock(session, async () => {
        try {
          applyOrder(
            await billingApi.createGiftCardOrder(request, intent.idempotencyKey),
            intent,
            session,
          );
        } catch (error) {
          failCurrentOperation(session, error);
        }
      });
    },
    [accountId, applyOrder, failCurrentOperation, withRequestLock],
  );

  const startSubscription = useCallback(
    async (request: CreateBillingSubscriptionRequest) => {
      if (!accountId || inFlightRef.current === sessionRef.current) return;
      const session = ++sessionRef.current;
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
        failure: null,
      });
      await withRequestLock(session, async () => {
        try {
          applySubscription(
            await billingApi.createSubscription(request, intent.idempotencyKey),
            intent,
            session,
          );
        } catch {
          failCurrentOperation(session);
        }
      });
    },
    [accountId, applySubscription, failCurrentOperation, withRequestLock],
  );

  const refreshActive = useCallback(async (expectedSession = sessionRef.current) => {
    if (expectedSession !== sessionRef.current) return;
    const session = expectedSession;
    await withRequestLock(session, async () => {
      if (session !== sessionRef.current) return;
      const current = stateRef.current;
      try {
        if (current.kind === 'TOPUP' && current.order) {
          const order =
            current.phase === 'AWAITING_PAYMENT'
              ? await billingApi.refreshTopup(current.order.orderId)
              : await billingApi.getOrder(current.order.orderId);
          applyOrder(order, current.intent, session);
          return;
        }
        if (current.kind === 'SUBSCRIPTION' && current.subscription?.purchaseAttemptId) {
          applySubscription(
            await billingApi.refreshSubscriptionPurchase(current.subscription.purchaseAttemptId),
            current.intent,
            session,
          );
        }
      } catch {
        flagError(session);
      }
    });
  }, [applyOrder, applySubscription, flagError, withRequestLock]);

  const retry = useCallback(async () => {
    if (inFlightRef.current === sessionRef.current) return;
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
      const session = sessionRef.current;
      setState((value) => ({ ...value, phase: 'CREATING', error: false, failure: null }));
      await withRequestLock(session, async () => {
        try {
          applyOrder(
            await billingApi.createTopup(intent.request, intent.idempotencyKey),
            intent,
            session,
          );
        } catch {
          failCurrentOperation(session);
        }
      });
      return;
    }
    if (current.intent?.kind === 'GIFT_CARD' && !current.order) {
      const intent = current.intent;
      const session = sessionRef.current;
      setState((value) => ({ ...value, phase: 'CREATING', error: false, failure: null }));
      await withRequestLock(session, async () => {
        try {
          applyOrder(
            await billingApi.createGiftCardOrder(intent.request, intent.idempotencyKey),
            intent,
            session,
          );
        } catch (error) {
          failCurrentOperation(session, error);
        }
      });
      return;
    }
    if (current.intent?.kind === 'SUBSCRIPTION' && !current.subscription) {
      const intent = current.intent;
      const session = sessionRef.current;
      setState((value) => ({ ...value, phase: 'CREATING', error: false, failure: null }));
      await withRequestLock(session, async () => {
        try {
          applySubscription(
            await billingApi.createSubscription(intent.request, intent.idempotencyKey),
            intent,
            session,
          );
        } catch {
          failCurrentOperation(session);
        }
      });
    }
  }, [applyOrder, applySubscription, failCurrentOperation, withRequestLock]);

  async function startTopupRetryWithIntent(
    intent: Extract<BillingCheckoutIntent, { kind: 'TOPUP_RETRY' }>,
  ) {
    const previousOrder =
      stateRef.current.order?.orderId === intent.orderId ? stateRef.current.order : null;
    const session = sessionRef.current;
    setState({
      open: true,
      kind: 'TOPUP',
      phase: 'CREATING',
      intent,
      order: previousOrder,
      subscription: null,
      error: false,
      failure: null,
    });
    await withRequestLock(session, async () => {
      try {
        applyOrder(
          await billingApi.retryTopup(intent.orderId, intent.idempotencyKey),
          intent,
          session,
        );
      } catch {
        failCurrentOperation(session);
      }
    });
  }

  const cancel = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== 'TOPUP' || !current.order) return;
    const session = sessionRef.current;
    await withRequestLock(session, async () => {
      try {
        applyOrder(await billingApi.cancelTopup(current.order!.orderId), current.intent, session);
      } catch {
        flagError(session);
      }
    });
  }, [applyOrder, flagError, withRequestLock]);

  // Closing the dialog ends the checkout session entirely: the generation bump
  // invalidates in-flight responses so they cannot reopen the dialog, and the
  // next selection starts over with a new idempotency key.
  const close = useCallback(() => {
    sessionRef.current += 1;
    inFlightRef.current = null;
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    sessionRef.current += 1;
    inFlightRef.current = null;
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
    clearLegacyBillingIntentStorage(accountId);
    return () => {
      mountedRef.current = false;
    };
  }, [accountId]);

  useEffect(() => {
    const shouldPoll = state.open && state.phase === 'AWAITING_PAYMENT';
    if (!shouldPoll) return;
    const session = sessionRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshActive(session);
    }, 3_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshActive(session);
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
    startGiftCard,
    startSubscription,
    refreshActive,
    retry,
    cancel,
    close,
  };
}

export { phaseForOrder, phaseForSubscription };
