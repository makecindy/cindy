/**
 * Billing desktop wire contract.
 *
 * Renderer only receives fixed business methods through preload. It cannot choose
 * an HTTP path, target service, or arbitrary headers.
 */

import type { ModelAccessBalance, ModelAccessCreditUsage } from './modelAccess';

export const BILLING_INVOKE = {
  GET_BALANCE: 'billing:get-balance',
  GET_CREDIT_USAGE: 'billing:get-credit-usage',
  GET_CATALOG: 'billing:get-catalog',
  LIST_ORDERS: 'billing:list-orders',
  GET_ORDER: 'billing:get-order',
  CREATE_TOPUP: 'billing:create-topup',
  REFRESH_TOPUP: 'billing:refresh-topup',
  CANCEL_TOPUP: 'billing:cancel-topup',
  RETRY_TOPUP: 'billing:retry-topup',
  CREATE_SUBSCRIPTION: 'billing:create-subscription',
  GET_CURRENT_SUBSCRIPTION: 'billing:get-current-subscription',
  REFRESH_SUBSCRIPTION_PURCHASE: 'billing:refresh-subscription-purchase',
  QUOTE_PLAN_CHANGE: 'billing:quote-plan-change',
  CONFIRM_PLAN_CHANGE: 'billing:confirm-plan-change',
  REFRESH_PLAN_CHANGE: 'billing:refresh-plan-change',
  CANCEL_PLAN_CHANGE: 'billing:cancel-plan-change',
  OPEN_PAYMENT_REDIRECT: 'billing:open-payment-redirect',
} as const;

export type BillingPaymentAction =
  | { type: 'QR_CODE'; value: string; expiresAt: string }
  | { type: 'REDIRECT'; url: string; expiresAt: string };

export type BillingFulfillmentStatus = 'NOT_STARTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type BillingPurchaseOption = {
  id: string;
  provider: string;
  capability: 'ONE_TIME_PAYMENT' | 'MERCHANT_INITIATED_MANDATE' | 'PROVIDER_MANAGED_SUBSCRIPTION';
  paymentAction: BillingPaymentAction['type'];
};

export type BillingCatalogOffer = {
  code: string;
  interval: 'MONTH' | 'YEAR' | null;
  currency: string;
  amount: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  creditAmount: string | null;
  rolloverCap: string | null;
  purchaseOptions: BillingPurchaseOption[];
};

export type BillingCatalogProduct = {
  code: string;
  name: string;
  kind: 'CREDIT_TOPUP' | 'SUBSCRIPTION';
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
  /**
   * Added by the fulfillment projection. Older servers may omit it; the client
   * must then stay in "crediting" and never infer delivery from payment alone.
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
  managementAction?: 'API_CANCEL' | 'PORTAL';
  entitlementStatus?: BillingFulfillmentStatus;
  currentPeriodStartAt: string | null;
  currentPeriodEndAt: string | null;
  entitlementValidUntil: string | null;
  cancelAtPeriodEnd: boolean;
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

export type BillingCurrentSubscription = {
  subscription: BillingSubscription | null;
};

export type CreateBillingTopupRequest = {
  offerCode: string;
  amount?: string;
  purchaseOptionId: string;
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
  openPaymentRedirect: (payload: { url: string }) => Promise<{ success: boolean }>;
}
