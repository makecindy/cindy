import type {
  BillingCatalog,
  BillingCurrentSubscription,
  BillingOrderList,
  BillingPaymentOrder,
  BillingPlanChange,
  BillingSubscription,
  CreateBillingSubscriptionRequest,
  CreateBillingTopupRequest,
} from '../../../shared/billing';
import type { ModelAccessBalance, ModelAccessCreditUsage } from '../../../shared/modelAccess';

export const billingApi = {
  getBalance(): Promise<ModelAccessBalance> {
    return window.electronAPI.billing.getBalance();
  },
  getCreditUsage(): Promise<ModelAccessCreditUsage> {
    return window.electronAPI.billing.getCreditUsage();
  },
  getCatalog(): Promise<BillingCatalog> {
    return window.electronAPI.billing.getCatalog();
  },
  listOrders(limit = 20): Promise<BillingOrderList> {
    return window.electronAPI.billing.listOrders({ limit });
  },
  getOrder(orderId: string): Promise<BillingPaymentOrder> {
    return window.electronAPI.billing.getOrder({ orderId });
  },
  createTopup(
    request: CreateBillingTopupRequest,
    idempotencyKey: string,
  ): Promise<BillingPaymentOrder> {
    return window.electronAPI.billing.createTopup({ request, idempotencyKey });
  },
  refreshTopup(orderId: string): Promise<BillingPaymentOrder> {
    return window.electronAPI.billing.refreshTopup({ orderId });
  },
  cancelTopup(orderId: string): Promise<BillingPaymentOrder> {
    return window.electronAPI.billing.cancelTopup({ orderId });
  },
  retryTopup(orderId: string, idempotencyKey: string): Promise<BillingPaymentOrder> {
    return window.electronAPI.billing.retryTopup({ orderId, idempotencyKey });
  },
  createSubscription(
    request: CreateBillingSubscriptionRequest,
    idempotencyKey: string,
  ): Promise<BillingSubscription> {
    return window.electronAPI.billing.createSubscription({ request, idempotencyKey });
  },
  getCurrentSubscription(): Promise<BillingCurrentSubscription> {
    return window.electronAPI.billing.getCurrentSubscription();
  },
  refreshSubscriptionPurchase(purchaseAttemptId: string): Promise<BillingSubscription> {
    return window.electronAPI.billing.refreshSubscriptionPurchase({ purchaseAttemptId });
  },
  quotePlanChange(targetOfferCode: string, idempotencyKey: string): Promise<BillingPlanChange> {
    return window.electronAPI.billing.quotePlanChange({ targetOfferCode, idempotencyKey });
  },
  confirmPlanChange(planChangeId: string): Promise<BillingPlanChange> {
    return window.electronAPI.billing.confirmPlanChange({ planChangeId });
  },
  refreshPlanChange(planChangeId: string): Promise<BillingPlanChange> {
    return window.electronAPI.billing.refreshPlanChange({ planChangeId });
  },
  cancelPlanChange(planChangeId: string): Promise<BillingPlanChange> {
    return window.electronAPI.billing.cancelPlanChange({ planChangeId });
  },
  openPaymentRedirect(url: string): Promise<{ success: boolean }> {
    return window.electronAPI.billing.openPaymentRedirect({ url });
  },
};
