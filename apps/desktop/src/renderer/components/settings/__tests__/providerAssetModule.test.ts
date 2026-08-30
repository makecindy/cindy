import { describe, expect, it } from 'vitest';

import type { BillingCatalog, BillingSubscription } from '../../../../shared/billing';
import {
  canUpgradeBillingPlan,
  hasBlockingBillingSubscription,
  isBillingPlanChangeEligible,
  resolveXdAssetActionLayout,
  resolveXdAssetModuleState,
} from '../providerAssetModule';

const OK = {
  billingAccessible: true,
  syncState: 'ok' as const,
  available: '18.42',
};

describe('resolveXdAssetModuleState', () => {
  it('个人云账号 + 拿到余额 → 渲染余额块', () => {
    expect(resolveXdAssetModuleState(OK)).toEqual({ kind: 'balance', available: '18.42' });
  });

  it('企业账号 → 整个资产模块不渲染(不是灰置、不给占位、也不给重试)', () => {
    expect(resolveXdAssetModuleState({ ...OK, billingAccessible: false })).toEqual({
      kind: 'hidden',
    });
    // 关键:企业账号即使凭据同步失败也不该看到「重试余额」——那笔钱不属于这个账号。
    expect(
      resolveXdAssetModuleState({ ...OK, billingAccessible: false, syncState: 'failed' }),
    ).toEqual({ kind: 'hidden' });
  });

  it('凭据同步失败 → 故障态(本该有、这次拿不到,所以给重试)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'failed' })).toEqual({ kind: 'fault' });
    // 故障态优先于「余额还没回来」:两者同时成立时用户需要的是恢复入口。
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'failed', available: null })).toEqual({
      kind: 'fault',
    });
  });

  it('企业未开通 / 服务未启用 → 不渲染(没有可恢复的东西,给重试是假承诺)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'unsupported' })).toEqual({
      kind: 'hidden',
    });
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'disabled' })).toEqual({ kind: 'hidden' });
  });

  it('余额查询不支持 / 尚未返回 → 不渲染,不显示「—」占位', () => {
    expect(resolveXdAssetModuleState({ ...OK, available: null })).toEqual({ kind: 'hidden' });
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'syncing', available: null })).toEqual({
      kind: 'hidden',
    });
  });

  it('同步中但余额已有缓存 → 照常显示(不为了一次刷新把数字抽走)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'syncing' })).toEqual({
      kind: 'balance',
      available: '18.42',
    });
  });
});

describe('hasBlockingBillingSubscription', () => {
  function sub(status: BillingSubscription['status']): BillingSubscription {
    return { status } as BillingSubscription;
  }

  it('TRIALING / ACTIVE / PAST_DUE / UNPAID / PAUSED 视为已有生效订阅', () => {
    expect(hasBlockingBillingSubscription(sub('TRIALING'))).toBe(true);
    expect(hasBlockingBillingSubscription(sub('ACTIVE'))).toBe(true);
    expect(hasBlockingBillingSubscription(sub('PAST_DUE'))).toBe(true);
    expect(hasBlockingBillingSubscription(sub('UNPAID'))).toBe(true);
    expect(hasBlockingBillingSubscription(sub('PAUSED'))).toBe(true);
  });

  it('未完成首购、已取消、空值都不阻断', () => {
    expect(hasBlockingBillingSubscription(null)).toBe(false);
    expect(hasBlockingBillingSubscription(undefined)).toBe(false);
    expect(hasBlockingBillingSubscription(sub('INCOMPLETE'))).toBe(false);
    expect(hasBlockingBillingSubscription(sub('INCOMPLETE_EXPIRED'))).toBe(false);
    expect(hasBlockingBillingSubscription(sub('CANCELED'))).toBe(false);
  });
});

const plusMonth: BillingSubscription = {
  subscriptionId: 'sub_1',
  status: 'ACTIVE',
  provider: 'stripe',
  currentPeriodStartAt: null,
  currentPeriodEndAt: null,
  entitlementValidUntil: null,
  cancelAtPeriodEnd: false,
  effectivePlan: {
    version: 1,
    product: { code: 'plus', kind: 'SUBSCRIPTION', level: 1 },
    offer: { code: 'plus_month', interval: 'MONTH' },
    terms: { amount: '9', currency: 'usd', creditAmount: '100', rolloverCap: '0' },
    capturedAt: '2026-01-01T00:00:00.000Z',
  },
  purchaseAttemptId: null,
  paymentAction: null,
};

function monthOffer(code: string, provider = 'stripe') {
  return {
    code,
    interval: 'MONTH' as const,
    currency: 'usd',
    amount: '20',
    minAmount: null,
    maxAmount: null,
    creditAmount: '250',
    rolloverCap: '0',
    purchaseOptions: [
      {
        id: `listing_${code}`,
        provider,
        capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
        paymentAction: 'REDIRECT' as const,
      },
    ],
  };
}

const plusAndMaxCatalog: BillingCatalog = {
  products: [
    {
      code: 'plus',
      name: 'Plus',
      kind: 'SUBSCRIPTION',
      level: 1,
      sortOrder: 1,
      offers: [monthOffer('plus_month')],
    },
    {
      code: 'max',
      name: 'Max',
      kind: 'SUBSCRIPTION',
      level: 2,
      sortOrder: 2,
      offers: [monthOffer('max_month')],
    },
  ],
};

const maxOnlyCatalog: BillingCatalog = {
  products: [
    {
      code: 'max',
      name: 'Max',
      kind: 'SUBSCRIPTION',
      level: 2,
      sortOrder: 2,
      offers: [monthOffer('max_month')],
    },
  ],
};

describe('canUpgradeBillingPlan', () => {
  it('非套餐或未完成首购 → 不能升级', () => {
    expect(canUpgradeBillingPlan(null, plusAndMaxCatalog)).toBe(false);
    expect(canUpgradeBillingPlan({ ...plusMonth, status: 'INCOMPLETE' }, plusAndMaxCatalog)).toBe(
      false,
    );
  });

  it('ACTIVE 月付且目录有更高等级可购档 → 可升级', () => {
    expect(canUpgradeBillingPlan(plusMonth, plusAndMaxCatalog)).toBe(true);
  });

  it('已经是最高档 → 升满，不能再升级', () => {
    const maxed: BillingSubscription = {
      ...plusMonth,
      effectivePlan: plusMonth.effectivePlan && {
        ...plusMonth.effectivePlan,
        product: { ...plusMonth.effectivePlan.product, code: 'max', level: 2 },
        offer: { ...plusMonth.effectivePlan.offer, code: 'max_month' },
      },
    };
    expect(canUpgradeBillingPlan(maxed, plusAndMaxCatalog)).toBe(false);
    expect(canUpgradeBillingPlan(maxed, maxOnlyCatalog)).toBe(false);
  });

  it('年付 / 取消待到期 / 非 ACTIVE 不能走更改套餐', () => {
    expect(
      canUpgradeBillingPlan(
        {
          ...plusMonth,
          effectivePlan: plusMonth.effectivePlan && {
            ...plusMonth.effectivePlan,
            offer: { ...plusMonth.effectivePlan.offer, interval: 'YEAR' },
          },
        },
        plusAndMaxCatalog,
      ),
    ).toBe(false);
    expect(
      canUpgradeBillingPlan({ ...plusMonth, cancelAtPeriodEnd: true }, plusAndMaxCatalog),
    ).toBe(false);
    expect(canUpgradeBillingPlan({ ...plusMonth, status: 'PAST_DUE' }, plusAndMaxCatalog)).toBe(
      false,
    );
  });

  it('目录还没回来且符合更改套餐入口 → 未知，不提前判死', () => {
    expect(canUpgradeBillingPlan(plusMonth, null)).toBe(null);
    expect(isBillingPlanChangeEligible(plusMonth)).toBe(true);
  });

  it('更高档不可购买时不算能升级', () => {
    const comingSoon: BillingCatalog = {
      products: [
        {
          code: 'max',
          name: 'Max',
          kind: 'SUBSCRIPTION',
          level: 2,
          sortOrder: 2,
          offers: [
            {
              ...monthOffer('max_month'),
              salesState: 'COMING_SOON',
              purchasable: false,
              unavailableReason: 'OFFER_COMING_SOON',
            },
          ],
        },
      ],
    };
    expect(canUpgradeBillingPlan(plusMonth, comingSoon)).toBe(false);
  });

  it('更高档只有桌面接不住的渠道时不算能升级', () => {
    const unknownProvider: BillingCatalog = {
      products: [
        {
          code: 'max',
          name: 'Max',
          kind: 'SUBSCRIPTION',
          level: 2,
          sortOrder: 2,
          offers: [monthOffer('max_month', 'futurepay')],
        },
      ],
    };
    expect(canUpgradeBillingPlan(plusMonth, unknownProvider)).toBe(false);
  });

  it('更高档只有一次性支付能力时不算能升级', () => {
    const oneTimeOnly: BillingCatalog = {
      products: [
        {
          code: 'max',
          name: 'Max',
          kind: 'SUBSCRIPTION',
          level: 2,
          sortOrder: 2,
          offers: [
            {
              ...monthOffer('max_month'),
              purchaseOptions: [
                {
                  id: 'listing_max_month',
                  provider: 'stripe',
                  capability: 'ONE_TIME_PAYMENT',
                  paymentAction: 'REDIRECT',
                },
              ],
            },
          ],
        },
      ],
    };
    expect(canUpgradeBillingPlan(plusMonth, oneTimeOnly)).toBe(false);
  });

  it('更高档同时有接得住和接不住的选项时仍可升级', () => {
    const mixed: BillingCatalog = {
      products: [
        {
          code: 'max',
          name: 'Max',
          kind: 'SUBSCRIPTION',
          level: 2,
          sortOrder: 2,
          offers: [
            {
              ...monthOffer('max_month'),
              purchaseOptions: [
                {
                  id: 'listing_max_future',
                  provider: 'futurepay',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
                  paymentAction: 'REDIRECT',
                },
                {
                  id: 'listing_max_month',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
                  paymentAction: 'REDIRECT',
                },
              ],
            },
          ],
        },
      ],
    };
    expect(canUpgradeBillingPlan(plusMonth, mixed)).toBe(true);
  });
});

describe('resolveXdAssetActionLayout', () => {
  it('订阅还没回来 → 先不画右侧主动作', () => {
    expect(resolveXdAssetActionLayout({ hasBlockingSubscription: null, canUpgrade: null })).toEqual(
      { primary: null },
    );
  });

  it('非套餐 → 购买套餐，不看目录', () => {
    expect(
      resolveXdAssetActionLayout({ hasBlockingSubscription: false, canUpgrade: true }),
    ).toEqual({ primary: 'buy-plan' });
  });

  it('有套餐且还能升级 → 升级套餐', () => {
    expect(resolveXdAssetActionLayout({ hasBlockingSubscription: true, canUpgrade: true })).toEqual(
      { primary: 'upgrade-plan' },
    );
  });

  it('升满或无法改档 → 余额充值', () => {
    expect(
      resolveXdAssetActionLayout({ hasBlockingSubscription: true, canUpgrade: false }),
    ).toEqual({ primary: 'topup' });
  });

  it('有套餐但升级资格还未知 → 先不画右侧主动作', () => {
    expect(resolveXdAssetActionLayout({ hasBlockingSubscription: true, canUpgrade: null })).toEqual(
      { primary: null },
    );
  });
});
