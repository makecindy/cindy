/**
 * Cindy AI 账户区：个人信用余额与企业/本机 Gateway 的周期额度分开呈现。
 * 个人计费权限不因展示企业额度而扩大；没有查询结果时明确区分加载和暂不可用，
 * 不隐藏恢复入口，也不编造零余额。购买/升级仍沿用个人账本的既有权限与决策。
 */

import { BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES } from '../../../shared/billing';
import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingSubscription,
} from '../../../shared/billing';
import type { ModelAccessStatus } from '../../../shared/modelAccess';
import { isSupportedPurchaseOption } from '../../features/billing/purchaseSupport';
import type { ClaudeAccountUsageSnapshot } from '../../hooks/useClaudeAccountUsage';

export type ProviderAssetModuleState =
  | { kind: 'hidden' }
  | { kind: 'fault' }
  | { kind: 'balance'; available: string }
  | { kind: 'quota'; quota: ClaudeAccountUsageSnapshot }
  | { kind: 'loading'; scope: 'balance' | 'quota' }
  | { kind: 'unavailable'; scope: 'balance' | 'quota' };

export interface XdAssetModuleInput {
  /** `canAccessBillingSettings` 的结果：cloud + personal 才为 true。 */
  billingAccessible: boolean;
  /** 网关凭据自动下发的同步状态（useModelAccessStatus）。 */
  syncState: ModelAccessStatus['state'];
  /** 额度池账本里的可用余额（useModelAccessCreditUsage）；拿不到为 null。 */
  available: string | null;
  quotaAccessible?: boolean;
  quota?: ClaudeAccountUsageSnapshot | null;
  loading?: boolean;
}

export function hasBlockingBillingSubscription(
  subscription: BillingSubscription | null | undefined,
): boolean {
  return (
    subscription != null &&
    BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(subscription.status)
  );
}

export type XdAssetPrimaryAction = 'buy-plan' | 'upgrade-plan' | 'topup';

export type XdAssetActionLayout = { primary: XdAssetPrimaryAction | null };

/**
 * 计费页「更改套餐」入口同一组门槛：ACTIVE、未取消待到期、月付。年付 / 非 ACTIVE /
 * 取消待到期都无法在客户端改档，右侧改走余额充值。
 */
export function isBillingPlanChangeEligible(
  subscription: BillingSubscription | null | undefined,
): boolean {
  return (
    subscription != null &&
    subscription.status === 'ACTIVE' &&
    !subscription.cancelAtPeriodEnd &&
    subscription.effectivePlan?.offer.interval === 'MONTH' &&
    typeof subscription.provider === 'string' &&
    subscription.provider.length > 0
  );
}

function catalogOfferPurchasable(offer: BillingCatalogOffer): boolean {
  const projected =
    offer.salesState !== undefined &&
    offer.purchasable !== undefined &&
    offer.unavailableReason !== undefined;
  if (!projected) return offer.purchaseOptions.length > 0;
  return offer.purchasable === true && offer.purchaseOptions.length > 0;
}

/**
 * 当前套餐在目录里是否还有更高等级、同周期、同渠道、可购买的订阅档。
 * `catalog === null` 表示还没拿到目录：符合更改套餐入口时返回 `null`（未知），
 * 否则可以直接否定。
 */
export function canUpgradeBillingPlan(
  subscription: BillingSubscription | null | undefined,
  catalog: BillingCatalog | null,
): boolean | null {
  if (!hasBlockingBillingSubscription(subscription) || !subscription?.effectivePlan) {
    return false;
  }
  if (!isBillingPlanChangeEligible(subscription)) return false;
  if (catalog == null) return null;

  const current = subscription.effectivePlan;
  const provider = subscription.provider;
  if (!provider) return false;

  return catalog.products.some((product) => {
    if (product.kind !== 'SUBSCRIPTION') return false;
    if (product.level == null || product.level <= current.product.level) return false;
    return product.offers.some((offer) => {
      if (offer.interval !== current.offer.interval) return false;
      if (offer.code === current.offer.code) return false;
      if (!catalogOfferPurchasable(offer)) return false;
      return offer.purchaseOptions.some(
        (option) =>
          option.provider === provider && isSupportedPurchaseOption(option, 'SUBSCRIPTION'),
      );
    });
  });
}

/**
 * 右侧主动作决议。订阅还没回来时不猜（`primary: null`），避免已订用户闪一下「购买套餐」。
 * 确认没有生效订阅 → 购买；确认还能升级 → 升级；确认升满或无法改档 → 充值。
 */
export function resolveXdAssetActionLayout(input: {
  hasBlockingSubscription: boolean | null;
  canUpgrade: boolean | null;
}): XdAssetActionLayout {
  if (input.hasBlockingSubscription == null) return { primary: null };
  if (!input.hasBlockingSubscription) return { primary: 'buy-plan' };
  if (input.canUpgrade === true) return { primary: 'upgrade-plan' };
  if (input.canUpgrade === false) return { primary: 'topup' };
  return { primary: null };
}

export function resolveXdAssetModuleState(input: XdAssetModuleInput): ProviderAssetModuleState {
  const { billingAccessible, syncState, available } = input;
  // Organization/local Gateway budgets use their own native-currency snapshot, not the
  // personal credit ledger. Never grant billing/purchase access merely to show this quota.
  if (input.quotaAccessible) {
    if (syncState === 'failed') return { kind: 'fault' };
    return input.quota
      ? { kind: 'quota', quota: input.quota }
      : { kind: input.loading ? 'loading' : 'unavailable', scope: 'quota' };
  }
  // 除独立周期额度外，个人余额与充值仅对有计费权限的账户展示。
  if (!billingAccessible) return { kind: 'hidden' };
  // 企业未开通网关（unsupported）不是故障：没有可恢复的东西，给重试是假承诺。
  if (syncState === 'unsupported' || syncState === 'disabled') return { kind: 'hidden' };
  // 凭据没同步上 → 余额本该有但这次拿不到，给说明 + 重试。
  if (syncState === 'failed') return { kind: 'fault' };
  // 缺值不是零余额；加载结束仍没有数据时，保留刷新入口。
  if (available === null)
    return { kind: input.loading ? 'loading' : 'unavailable', scope: 'balance' };
  return { kind: 'balance', available };
}
