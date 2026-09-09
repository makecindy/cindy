/**
 * useXdAssetPrimaryAction — 供应商页余额块右侧那颗 Black Pill。
 *
 * 查看用量始终在；右侧只留一颗：
 *   非套餐 → 购买套餐
 *   目录里还有更高等级可改档 → 升级套餐
 *   已经升满，或年付 / 非 ACTIVE / 取消待到期没法改档 → 余额充值
 *
 * 只在余额块真正渲染时启用。订阅请求失败按非套餐（出购买套餐）：把已订用户推进
 * 购买弹窗，计费页自己会用 purchaseBlocked 兜住。目录失败且仍符合更改套餐入口时
 * 按可升级处理，避免把还能升的人直接推进充值。
 *
 * 不跨实例缓存决议。购买 / 升级 / 取消 / 恢复发生在计费页，回到供应商页会重新
 * 挂载：缓存会在新请求回来前画出上一套套餐的 CTA。宁可短暂不画右侧按钮。
 */

import { useEffect, useState } from 'react';

import { billingApi } from '../features/billing/api';
import { useAuth } from '../contexts/AuthContext';
import {
  canUpgradeBillingPlan,
  hasBlockingBillingSubscription,
  resolveXdAssetActionLayout,
  type XdAssetPrimaryAction,
} from '../components/settings/providerAssetModule';

export function useXdAssetPrimaryAction(enabled: boolean): XdAssetPrimaryAction | null {
  const { dataOwnerId, mode, user } = useAuth();
  const actionEnabled = enabled && mode === 'cloud' && user?.membershipKind === 'personal';
  const [primary, setPrimary] = useState<XdAssetPrimaryAction | null>(null);

  useEffect(() => {
    if (!actionEnabled || !dataOwnerId) {
      setPrimary(null);
      return;
    }
    let cancelled = false;
    setPrimary(null);

    void Promise.all([
      billingApi
        .getCurrentSubscription()
        .then((res) => res.subscription)
        .catch(() => null),
      billingApi.getCatalog().catch(() => null),
    ]).then(([subscription, catalog]) => {
      if (cancelled) return;
      const hasBlocking = hasBlockingBillingSubscription(subscription);
      const canUpgrade = canUpgradeBillingPlan(subscription, catalog);
      const resolvedCanUpgrade = catalog == null && canUpgrade == null ? true : canUpgrade;
      setPrimary(
        resolveXdAssetActionLayout({
          hasBlockingSubscription: hasBlocking,
          canUpgrade: resolvedCanUpgrade,
        }).primary,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [actionEnabled, dataOwnerId]);

  if (!actionEnabled || !dataOwnerId) return null;
  return primary;
}
