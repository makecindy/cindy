import type { BillingCatalogProduct, BillingPurchaseOption } from '../../../shared/billing';

export type SupportedBillingProvider = 'alipay' | 'stripe';

export type SupportedPurchaseOption = BillingPurchaseOption & {
  provider: SupportedBillingProvider;
};

export const SUPPORTED_BILLING_PROVIDERS = new Set<SupportedBillingProvider>(['alipay', 'stripe']);

const SUPPORTED_PAYMENT_ACTIONS = new Set<BillingPurchaseOption['paymentAction']>([
  'QR_CODE',
  'REDIRECT',
]);

const SUPPORTED_SUBSCRIPTION_CAPABILITIES = new Set<BillingPurchaseOption['capability']>([
  'MERCHANT_INITIATED_MANDATE',
  'PROVIDER_MANAGED_SUBSCRIPTION',
]);

export function isSupportedBillingProvider(
  provider: string | undefined,
): provider is SupportedBillingProvider {
  return (
    typeof provider === 'string' &&
    SUPPORTED_BILLING_PROVIDERS.has(provider as SupportedBillingProvider)
  );
}

/**
 * Desktop 实际接得住的购买选项。目录里可能出现未来渠道、或订阅商品挂上
 * `ONE_TIME_PAYMENT`：计费页会滤掉，升级 CTA 必须用同一判据，否则会把人带进空弹窗。
 */
export function isSupportedPurchaseOption(
  option: BillingPurchaseOption,
  productKind: BillingCatalogProduct['kind'],
): option is SupportedPurchaseOption {
  if (!isSupportedBillingProvider(option.provider)) return false;
  if (!SUPPORTED_PAYMENT_ACTIONS.has(option.paymentAction)) return false;
  return productKind === 'CREDIT_TOPUP'
    ? option.capability === 'ONE_TIME_PAYMENT'
    : SUPPORTED_SUBSCRIPTION_CAPABILITIES.has(option.capability);
}
