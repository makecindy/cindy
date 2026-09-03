/**
 * 供应商详情头下方「账户资产模块」的状态判定（纯函数，与渲染分离）。
 *
 * 这个槽位是通用的：网关账号填「可用余额 + 动作」，将来订阅账号可以填「当前套餐 +
 * 用量」。目前只有 Cindy AI 网关一种填充，判定逻辑先集中在这里，避免把三种互斥
 * 状态（不渲染 / 故障 / 有余额）散进 JSX 的嵌套三元里。
 *
 * 三种状态刻意区分开：
 *   - `hidden`：**本来就不该有**。org 账号（`canAccessBillingSettings` 同一判据）、
 *     local / 未登录、企业未开通网关，以及账户不支持余额查询。此时不显示「—」占位、
 *     也不留空的资产区 —— 卡片退化成标题行 + 状态 + 菜单。
 *   - `fault`：**本该有、这次拿不到**（凭据同步失败）。所以给一条故障说明 + 重试。
 *   - `balance`：正常态，标签 + 金额 + 右侧动作。
 *
 * 「不渲染」与「故障」的分野是这份判定存在的理由：把两者合成一个空态会让确实有钱
 * 的用户看不到恢复入口，把两者都给重试又会让 org 账号看到一个永远重试不出结果的
 * 按钮。
 *
 * 余额块的动作布局另走 `resolveXdAssetActionLayout`：查看用量始终在；右侧只留一颗
 * Black Pill —— 非套餐买套餐，还能升就升级，已经升满（或没法改套餐）才轮到余额充值。
 */

import { BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES } from '../../../shared/billing';
import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingSubscription,
} from '../../../shared/billing';
import type { ModelAccessStatus } from '../../../shared/modelAccess';
import { isSupportedPurchaseOption } from '../../features/billing/purchaseSupport';

export type ProviderAssetModuleState =
  { kind: 'hidden' } | { kind: 'fault' } | { kind: 'balance'; available: string };

export interface XdAssetModuleInput {
  /** `canAccessBillingSettings` 的结果：cloud + personal 才为 true。 */
  billingAccessible: boolean;
  /** 网关凭据自动下发的同步状态（useModelAccessStatus）。 */
  syncState: ModelAccessStatus['state'];
  /** 额度池账本里的可用余额（useModelAccessCreditUsage）；拿不到为 null。 */
  available: string | null;
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
  // 企业账号 / 未登录 / local：整个余额与充值面都不属于这个账号，连故障态都不该有。
  if (!billingAccessible) return { kind: 'hidden' };
  // 企业未开通网关（unsupported）不是故障：没有可恢复的东西，给重试是假承诺。
  if (syncState === 'unsupported' || syncState === 'disabled') return { kind: 'hidden' };
  // 凭据没同步上 → 余额本该有但这次拿不到，给说明 + 重试。
  if (syncState === 'failed') return { kind: 'fault' };
  // 账户未开通余额 / 租户不提供余额查询 / 首次请求还没回来 → 什么都不渲染。
  if (available === null) return { kind: 'hidden' };
  return { kind: 'balance', available };
}
