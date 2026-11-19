/**
 * Billing desktop wire contract.
 *
 * Renderer only receives fixed business methods through preload. It cannot choose
 * an HTTP path, target service, or arbitrary headers.
 */

import type {
  GiftCard,
  GiftCardCredit,
  GiftCardFailure,
  GiftCardStatus,
} from '@cindy/maker-shared/gift-card';

import type { ModelAccessBalance, ModelAccessCreditUsage } from './modelAccess';

export const BILLING_SUPPORT_EMAIL = 'xd-billing@xd.com';
export const BILLING_FEEDBACK_EMAIL = 'feedback@cindy.app';

/**
 * Validates mailto URLs for the fixed billing and feedback inboxes.
 * Subject/body are display data from the renderer; recipient-affecting headers
 * must stay outside this capability boundary.
 */
export function isAllowedBillingMailto(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    const recipient = decodeURIComponent(parsed.pathname).toLowerCase();
    const queryKeys = [...parsed.searchParams.keys()];
    const hasDuplicateQueryKey = new Set(queryKeys).size !== queryKeys.length;
    const subject = parsed.searchParams.get('subject');
    const hasSubjectControlCharacter =
      subject !== null && /[\u0000-\u001f\u007f-\u009f]/u.test(subject);
    return (
      parsed.protocol === 'mailto:' &&
      (recipient === BILLING_SUPPORT_EMAIL || recipient === BILLING_FEEDBACK_EMAIL) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.host &&
      !parsed.hash &&
      !hasDuplicateQueryKey &&
      !hasSubjectControlCharacter &&
      queryKeys.every((key) => key === 'subject' || key === 'body')
    );
  } catch {
    return false;
  }
}

/**
 * Keeps the sender check explicit at the main-process adapter boundary. The
 * URL policy alone is not sufficient authorization for a privileged shell call.
 */
export function isAllowedBillingMailtoRequest(
  value: unknown,
  isTrustedSender: boolean,
): value is string {
  return isTrustedSender && isAllowedBillingMailto(value);
}

export const BILLING_INVOKE = {
  GET_BALANCE: 'billing:get-balance',
  GET_CREDIT_USAGE: 'billing:get-credit-usage',
  GET_CATALOG: 'billing:get-catalog',
  LIST_ORDERS: 'billing:list-orders',
  LIST_PAYMENT_HISTORY: 'billing:list-payment-history',
  GET_ORDER: 'billing:get-order',
  CREATE_TOPUP: 'billing:create-topup',
  REFRESH_TOPUP: 'billing:refresh-topup',
  CANCEL_TOPUP: 'billing:cancel-topup',
  RETRY_TOPUP: 'billing:retry-topup',
  CREATE_SUBSCRIPTION: 'billing:create-subscription',
  GET_CURRENT_SUBSCRIPTION: 'billing:get-current-subscription',
  CANCEL_CURRENT_SUBSCRIPTION: 'billing:cancel-current-subscription',
  RESUME_CURRENT_SUBSCRIPTION: 'billing:resume-current-subscription',
  REFRESH_SUBSCRIPTION_PURCHASE: 'billing:refresh-subscription-purchase',
  QUOTE_PLAN_CHANGE: 'billing:quote-plan-change',
  CONFIRM_PLAN_CHANGE: 'billing:confirm-plan-change',
  REFRESH_PLAN_CHANGE: 'billing:refresh-plan-change',
  CANCEL_PLAN_CHANGE: 'billing:cancel-plan-change',
  OPEN_SUBSCRIPTION_PORTAL: 'billing:open-subscription-portal',
  OPEN_PAYMENT_REDIRECT: 'billing:open-payment-redirect',
  PREVIEW_GIFT_CARD: 'billing:preview-gift-card',
  REDEEM_GIFT_CARD: 'billing:redeem-gift-card',
  GET_GIFT_CARD_PURCHASE_POLICY: 'billing:get-gift-card-purchase-policy',
  CREATE_GIFT_CARD_ORDER: 'billing:create-gift-card-order',
  LIST_PURCHASED_GIFT_CARDS: 'billing:list-purchased-gift-cards',
  REVEAL_PURCHASED_GIFT_CARD: 'billing:reveal-purchased-gift-card',
  SEND_PURCHASED_GIFT_CARD_EMAIL: 'billing:send-purchased-gift-card-email',
} as const;

/**
 * 礼品卡的卡片、入账结果与不可领取原因：与 Mobile 共用同一份契约，
 * 字段说明见 `@cindy/maker-shared/gift-card`。
 */
export type BillingGiftCardStatus = GiftCardStatus;
export type BillingGiftCard = GiftCard;
export type BillingGiftCardCredit = GiftCardCredit;
/** 服务端明确给出的不可领取原因；网络或服务故障走 IPC 错误，不在此列。 */
export type BillingGiftCardFailure = GiftCardFailure;

export type BillingGiftCardPreviewResult =
  { ok: true; card: BillingGiftCard } | { ok: false; reason: BillingGiftCardFailure };

export type BillingGiftCardRedeemResult =
  | { ok: true; card: BillingGiftCard; credit: BillingGiftCardCredit }
  | { ok: false; reason: BillingGiftCardFailure };

export type BillingPaymentAction =
  | { type: 'QR_CODE'; value: string; expiresAt: string }
  | { type: 'REDIRECT'; url: string; expiresAt: string };

export type BillingSubscriptionPortalResult =
  { success: true } | { success: false; timedOut?: true };

export type BillingFulfillmentStatus = 'NOT_STARTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type BillingPurchaseOption = {
  id: string;
  provider: string;
  capability: 'ONE_TIME_PAYMENT' | 'MERCHANT_INITIATED_MANDATE' | 'PROVIDER_MANAGED_SUBSCRIPTION';
  paymentAction: BillingPaymentAction['type'];
};

export type BillingCatalogOfferSalesState = 'COMING_SOON' | 'AVAILABLE';
export type BillingCatalogOfferUnavailableReason =
  'OFFER_COMING_SOON' | 'NO_AVAILABLE_PAYMENT_CHANNEL';

export type BillingCatalogOffer = {
  code: string;
  /**
   * Operator-managed display name from the server. When omitted, Desktop does
   * not render an offer name or fall back to the internal offer code.
   */
  name?: string;
  /**
   * Optional only while Desktop remains compatible with older Model Access
   * servers. New servers always send the three availability fields together.
   */
  salesState?: BillingCatalogOfferSalesState;
  purchasable?: boolean;
  unavailableReason?: BillingCatalogOfferUnavailableReason | null;
  interval: 'MONTH' | 'YEAR' | null;
  currency: string;
  amount: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  creditAmount: string | null;
  rolloverCap: string | null;
  purchaseOptions: BillingPurchaseOption[];
};

/**
 * GIFT_CARD：用户自己买的礼品卡。它的 Offer 与固定充值同形（面额 = amount = creditAmount），
 * 付款走同一套一次性订单；成功后由服务端生成礼品卡，而不是直接给当前账号充值。
 */
export type BillingProductKind = 'CREDIT_TOPUP' | 'SUBSCRIPTION' | 'GIFT_CARD';

export type BillingCatalogProduct = {
  code: string;
  name: string;
  kind: BillingProductKind;
  level: number | null;
  sortOrder: number;
  offers: BillingCatalogOffer[];
};

export type BillingCatalog = {
  products: BillingCatalogProduct[];
};

export type BillingPaymentOrderStatus =
  'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'EXPIRED';

export type BillingPaymentOrder = {
  orderId: string;
  productCode: string;
  offerCode: string;
  amount: string;
  currency: string;
  status: BillingPaymentOrderStatus;
  paymentAction: BillingPaymentAction | null;
  /** 一次性订单买的是什么；旧服务端不下发时按充值处理。 */
  productKind?: 'CREDIT_TOPUP' | 'GIFT_CARD';
  /** 礼品卡订单的张数；充值为 1。旧服务端不下发。 */
  quantity?: number;
  /**
   * Added by the fulfillment projection. Older servers may omit it; checkout
   * currently infers COMPLETED from payment status alone (server reconciles).
   */
  fulfillmentStatus?: BillingFulfillmentStatus;
  createdAt: string;
  updatedAt: string;
};

export type BillingSubscriptionStatus =
  | 'INCOMPLETE'
  | 'INCOMPLETE_EXPIRED'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'UNPAID'
  | 'CANCELED'
  | 'PAUSED';

/**
 * 这些状态视为已有生效订阅：计费页阻断再买新套餐；供应商页据此把右侧主动作从
 * 「购买套餐」换成「升级套餐」或「余额充值」。INCOMPLETE / INCOMPLETE_EXPIRED 属于
 * 未完成首购，只活在当前 checkout 会话里，不算。
 */
export const BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES: readonly BillingSubscriptionStatus[] =
  ['TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'PAUSED'];

export type BillingPlanChangeType = 'UPGRADE' | 'DOWNGRADE';

/**
 * Open plan-change states the client may act on. Terminal states (APPLIED /
 * CANCELED / FAILED / EXPIRED) are also part of the wire enum because the
 * plan-change endpoints echo them back after confirm/refresh/cancel.
 */
export type BillingPlanChangeStatus =
  | 'QUOTED'
  | 'PENDING_PROVIDER'
  | 'AWAITING_PAYMENT'
  | 'SCHEDULED'
  | 'APPLIED'
  | 'CANCELED'
  | 'FAILED'
  | 'EXPIRED';

export type BillingPlanChange = {
  planChangeId: string;
  changeType: BillingPlanChangeType;
  status: BillingPlanChangeStatus;
  quotedAmountMinor: number | null;
  quotedCurrency: string | null;
  quoteExpiresAt: string | null;
  effectiveAt: string;
  paymentAction: BillingPaymentAction | null;
};

export type BillingPlanChangeTargetPlan = {
  product: { code: string; level: number };
  offer: { code: string; interval: 'MONTH' | 'YEAR' };
  terms: { amount: string; currency: string; creditAmount: string };
};

export type BillingPendingPlanChange = BillingPlanChange & {
  /** Null when the server could not safely parse the historical snapshot. */
  targetPlan: BillingPlanChangeTargetPlan | null;
};

export type BillingSubscription = {
  subscriptionId: string;
  status: BillingSubscriptionStatus;
  provider?: string;
  entitlementStatus?: BillingFulfillmentStatus;
  currentPeriodStartAt: string | null;
  currentPeriodEndAt: string | null;
  entitlementValidUntil: string | null;
  cancelAtPeriodEnd: boolean;
  /** 取消待到期且账期未过的订阅是否可恢复（服务端下发；旧服务端无此字段）。 */
  resumable?: boolean;
  effectivePlan: {
    version: 1;
    product: {
      code: string;
      kind: 'SUBSCRIPTION';
      level: number;
    };
    offer: {
      code: string;
      interval: 'MONTH' | 'YEAR';
    };
    terms: {
      amount: string;
      currency: string;
      creditAmount: string;
      rolloverCap: string;
    };
    capturedAt: string;
  } | null;
  purchaseAttemptId: string | null;
  paymentAction: BillingPaymentAction | null;
  /**
   * Server-owned recovery projection of the newest open plan change. `null`
   * means "no open change"; `undefined` means the server (or endpoint) does
   * not emit the field, so the client must not treat it as a denial.
   */
  pendingPlanChange?: BillingPendingPlanChange | null;
};

export type BillingOrderList = {
  orders: BillingPaymentOrder[];
  nextCursor: string | null;
};

/** Settled payment facts; independent of checkout, contract and fulfillment state. */
export type BillingPaymentHistoryRecord = {
  recordId: string;
  sourceType: 'CREDIT_TOPUP' | 'SUBSCRIPTION_INVOICE' | 'GIFT_CARD';
  /** 礼品卡订单的张数；充值与订阅账单为 1（旧服务端不下发时也按 1）。 */
  quantity: number;
  sourceId: string;
  subscriptionId: string | null;
  productName: string | null;
  billingReason: string | null;
  amountPaidMinor: number | null;
  amount: string | null;
  currency: string;
  provider: string | null;
  providerTransactionId: string | null;
  paidAt: string | null;
  createdAt: string;
  periodStartAt: string | null;
  periodEndAt: string | null;
  refundSummary: {
    status: 'UNREFUNDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | null;
    refundedMinor: number;
    refundedAmount: string;
  };
};

export type BillingPaymentHistory = {
  records: BillingPaymentHistoryRecord[];
  nextCursor: string | null;
};

export type BillingCurrentSubscription = {
  subscription: BillingSubscription | null;
};

export type CreateBillingTopupRequest = {
  offerCode: string;
  amount?: string;
  purchaseOptionId: string;
};

export type CreateBillingGiftCardOrderRequest = {
  offerCode: string;
  /** 只有自填面额的价格方案带：单张面额（最多两位小数）；固定面额方案不带。 */
  amount?: string;
  /** 1–5 张；同一单的卡面、面额、署名与留言相同，每张一个兑换码。 */
  quantity: number;
  faceCode: string;
  senderName: string;
  message: string | null;
  purchaseOptionId: string;
};

/** 礼品卡购买限制，均由服务端给出；客户端据此限制可选张数，服务端仍会校验。 */
export type BillingGiftCardPurchasePolicy = {
  currency: string;
  /** 滚动 `windowHours` 小时内最多可买的张数（已支付与仍可支付的订单都算）。 */
  dailyLimit: number;
  windowHours: number;
  remaining: number;
  maxQuantityPerOrder: number;
  /** 单笔订单总额上限（如国内支付宝）；null 表示不限。 */
  maxOrderAmount: string | null;
  /** 单张面额范围；自填面额只能在这个范围内。旧服务端没有这两个字段时为 null。 */
  minFaceValue: string | null;
  maxFaceValue: string | null;
  faces: string[];
  maxSenderNameLength: number;
  maxMessageLength: number;
  /**
   * 同一张卡两次发到邮箱之间至少隔多少秒（不限次数，可以换邮箱）。旧服务端没有发信接口时
   * 为 null，界面不提供「发送到邮箱」。
   */
  emailCooldownSeconds: number | null;
};

/**
 * 我买的卡的状态。CLAIMED：被别人领走；REDEEMED_BY_YOU：买家自己兑换了；
 * REFUNDED：钱已退回（退款成功或拒付败诉），卡作废；ON_HOLD：退款或拒付还在处理，卡暂时
 * 不能用，之后可能恢复。
 */
export type BillingPurchasedGiftCardStatus =
  'UNCLAIMED' | 'CLAIMED' | 'REDEEMED_BY_YOU' | 'REFUNDED' | 'ON_HOLD';

export type BillingPurchasedGiftCard = {
  cardId: string;
  orderId: string;
  faceCode: string;
  amount: string;
  currency: string;
  senderName: string;
  message: string | null;
  codeTail: string;
  status: BillingPurchasedGiftCardStatus;
  claimedAt: string | null;
  /** 领取人领取时的昵称；只在 CLAIMED 时可能有值。 */
  claimedByName: string | null;
  purchasedAt: string;
  /** 最近一次发到邮箱的情况；没发过（或旧服务端）为 null。 */
  email: BillingPurchasedGiftCardEmail | null;
};

/**
 * 发到邮箱是异步的：PENDING 排队 → SENDING 交给发信方 → SENT / FAILED。
 * `nextAvailableAt` 之前这张卡不能再发（冷却），之后可以发到任何邮箱。
 */
export type BillingPurchasedGiftCardEmail = {
  recipient: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  updatedAt: string;
  nextAvailableAt: string;
};

/**
 * 发到邮箱的结果。服务端明确拒绝的几种情况作为结果返回，由界面就地说明：
 * 邮箱不合法、卡已被领取或已退款、还在冷却（`retryAt` 为可以再发的时间戳，拿不到时为 null）。
 */
export type BillingSendGiftCardEmailResult =
  | { ok: true; card: BillingPurchasedGiftCard }
  | { ok: false; reason: 'INVALID_EMAIL' | 'NOT_AVAILABLE' }
  | { ok: false; reason: 'COOLDOWN'; retryAt: number | null };

export type BillingPurchasedGiftCardList = {
  cards: BillingPurchasedGiftCard[];
  nextCursor: string | null;
  /**
   * 服务端是否支持把卡发到邮箱：支持发信的服务端每张卡都带 `email` 字段（没发过为 null），
   * 旧服务端没有这个字段，界面不提供「发送到邮箱」。
   */
  emailSupported: boolean;
};

/**
 * 买家取回的兑换码。领取链接由主进程按当前账号区域的分享站拼出（兑换码在 `#` 之后，
 * 不进请求路径）；分享站未配置时为 null，只能复制兑换码。
 */
export type BillingPurchasedGiftCardCode = {
  code: string;
  claimUrl: string | null;
};

export type CreateBillingSubscriptionRequest = {
  offerCode: string;
  purchaseOptionId: string;
};

export interface BillingRendererApi {
  getBalance: () => Promise<ModelAccessBalance>;
  getCreditUsage: () => Promise<ModelAccessCreditUsage>;
  getCatalog: () => Promise<BillingCatalog>;
  listOrders: (payload: { limit: number }) => Promise<BillingOrderList>;
  listPaymentHistory: (payload: { limit: number; cursor?: string }) => Promise<BillingPaymentHistory>;
  getOrder: (payload: { orderId: string }) => Promise<BillingPaymentOrder>;
  createTopup: (payload: {
    request: CreateBillingTopupRequest;
    idempotencyKey: string;
  }) => Promise<BillingPaymentOrder>;
  refreshTopup: (payload: { orderId: string }) => Promise<BillingPaymentOrder>;
  cancelTopup: (payload: { orderId: string }) => Promise<BillingPaymentOrder>;
  retryTopup: (payload: {
    orderId: string;
    idempotencyKey: string;
  }) => Promise<BillingPaymentOrder>;
  createSubscription: (payload: {
    request: CreateBillingSubscriptionRequest;
    idempotencyKey: string;
  }) => Promise<BillingSubscription>;
  getCurrentSubscription: () => Promise<BillingCurrentSubscription>;
  cancelCurrentSubscription: () => Promise<BillingSubscription>;
  resumeCurrentSubscription: () => Promise<BillingSubscription>;
  refreshSubscriptionPurchase: (payload: {
    purchaseAttemptId: string;
  }) => Promise<BillingSubscription>;
  quotePlanChange: (payload: {
    targetOfferCode: string;
    idempotencyKey: string;
  }) => Promise<BillingPlanChange>;
  confirmPlanChange: (payload: { planChangeId: string }) => Promise<BillingPlanChange>;
  refreshPlanChange: (payload: { planChangeId: string }) => Promise<BillingPlanChange>;
  cancelPlanChange: (payload: { planChangeId: string }) => Promise<BillingPlanChange>;
  openSubscriptionPortal: () => Promise<BillingSubscriptionPortalResult>;
  openPaymentRedirect: (payload: { url: string }) => Promise<{ success: boolean }>;
  previewGiftCard: (payload: { code: string }) => Promise<BillingGiftCardPreviewResult>;
  redeemGiftCard: (payload: { code: string }) => Promise<BillingGiftCardRedeemResult>;
  getGiftCardPurchasePolicy: () => Promise<BillingGiftCardPurchasePolicy>;
  createGiftCardOrder: (payload: {
    request: CreateBillingGiftCardOrderRequest;
    idempotencyKey: string;
  }) => Promise<BillingPaymentOrder>;
  listPurchasedGiftCards: (payload: {
    limit: number;
    cursor?: string;
  }) => Promise<BillingPurchasedGiftCardList>;
  revealPurchasedGiftCard: (payload: {
    cardId: string;
    /** 只决定领取链接用哪张卡面图；兑换码由服务端按 cardId 给出。 */
    faceCode: string;
  }) => Promise<BillingPurchasedGiftCardCode>;
  sendPurchasedGiftCardEmail: (payload: {
    cardId: string;
    email: string;
  }) => Promise<BillingSendGiftCardEmailResult>;
}
