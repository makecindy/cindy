import { describe, expect, it } from 'vitest';

import { resolveCreditTotals } from '../lib/creditPoolTotals';
import type { ModelAccessCreditUsage } from '../../shared/modelAccess';

type Pool = { remaining: string; used: string | null; total: string | null };

function usage(pools: Partial<Record<'plan' | 'purchased' | 'promotional', Pool>>): ModelAccessCreditUsage {
  const empty: Pool = { remaining: '0', used: null, total: null };
  return {
    available: '0',
    plan: pools.plan ?? empty,
    purchased: pools.purchased ?? empty,
    promotional: pools.promotional ?? empty,
    promotionalGrants: [],
    promotionalGrantsComplete: true,
    promotionalGrantConsistency: 'OBSERVED',
    ledgerUpdatedAt: null,
    scale: 9,
    observedAt: '2026-07-30T00:00:00Z',
  };
}

describe('resolveCreditTotals', () => {
  it('sums used and total across the three pools', () => {
    expect(
      resolveCreditTotals(
        usage({
          plan: { remaining: '38.20', used: '11.80', total: '50.00' },
          purchased: { remaining: '10.00', used: '2.00', total: '12.00' },
          promotional: { remaining: '0.00', used: '5.00', total: '5.00' },
        }),
      ),
    ).toEqual({ used: 18.8, total: 67 });
  });

  it('keeps nine-decimal ledger precision without float drift', () => {
    // 0.1 + 0.2 在 float 下是 0.30000000000000004; BigInt 汇总后再落地必须是 0.3
    expect(
      resolveCreditTotals(
        usage({
          plan: { remaining: '0.900000000', used: '0.100000000', total: '1' },
          purchased: { remaining: '0.800000000', used: '0.200000000', total: '1' },
          promotional: { remaining: '0', used: '0', total: '0' },
        }),
      ),
    ).toEqual({ used: 0.3, total: 2 });
  });

  it('backfills a pool with unknown history from its remaining balance', () => {
    // 实测回归: 订阅期末取消后 plan 池 used/total 为 null 但仍有 ¥1000 余额。
    // 跳过该池会让总额从 ¥1604 掉成 ¥604 —— 与设置页「可用余额 ¥1594.68」自相矛盾。
    const totals = resolveCreditTotals(
      usage({
        plan: { remaining: '1000.00', used: null, total: null },
        purchased: { remaining: '583.00', used: '0.00', total: '583.00' },
        promotional: { remaining: '11.68', used: '9.32', total: '21.00' },
      }),
    );
    expect(totals).toEqual({ used: 9.32, total: 1604 });
    // 核心不变量: 总额 − 已用 === Gateway 的 available (三池 remaining 之和)
    expect(totals!.total - totals!.used).toBeCloseTo(1000 + 583 + 11.68, 9);
  });

  it('keeps total − used equal to available when every pool history is known', () => {
    const totals = resolveCreditTotals(
      usage({
        plan: { remaining: '38.20', used: '11.80', total: '50.00' },
        purchased: { remaining: '10.00', used: '2.00', total: '12.00' },
        promotional: { remaining: '0.00', used: '5.00', total: '5.00' },
      }),
    );
    expect(totals!.total - totals!.used).toBeCloseTo(38.2 + 10 + 0, 9);
  });

  it('reports used / total for a top-up-only account whose plan pool is empty', () => {
    // 从未订阅过的账号: server 侧 planTotal 恒为 null, 但该池 remaining 是 0,
    // 兜底贡献 0, 不影响其余池的用量事实。
    expect(
      resolveCreditTotals(
        usage({
          plan: { remaining: '0', used: null, total: null },
          purchased: { remaining: '583.00', used: '17.00', total: '600.00' },
          promotional: { remaining: '0', used: '21.00', total: '21.00' },
        }),
      ),
    ).toEqual({ used: 38, total: 621 });
  });

  it('never reports used above total, whichever branch each pool takes', () => {
    // 「已用 > 总额」是绝不能出现的自相矛盾。不变量的两个来源:
    //   已知池 — server 用 used = total − remaining 反推且只在非负时返回值
    //            (nonNegativeDifference), 所以 used ≤ total;
    //   兜底池 — used 记 0、total 记 remaining(已校验非负)。
    // 混合两种分支、以及 rollover 让余额超过当期发放量(此时 server 返 null,
    // 该池落到兜底分支)都要满足。
    const cases: Partial<Record<'plan' | 'purchased' | 'promotional', Pool>>[] = [
      {
        // 订阅生效中: 三池用量全已知, plan 几乎花光
        plan: { remaining: '90.68', used: '909.32', total: '1000.00' },
        purchased: { remaining: '583.00', used: '0.00', total: '583.00' },
        promotional: { remaining: '11.68', used: '9.32', total: '21.00' },
      },
      {
        // 订阅过期: plan 用量转 null, 只剩余额可依
        plan: { remaining: '1000.00', used: null, total: null },
        purchased: { remaining: '583.00', used: '0.00', total: '583.00' },
        promotional: { remaining: '11.68', used: '9.32', total: '21.00' },
      },
      {
        // rollover 让 plan 余额超过当期发放量 → server 侧 used 为负, 返 null
        plan: { remaining: '1500.00', used: null, total: null },
        purchased: { remaining: '0.00', used: '600.00', total: '600.00' },
        promotional: { remaining: '0', used: null, total: null },
      },
    ];
    for (const pools of cases) {
      const totals = resolveCreditTotals(usage(pools));
      expect(totals).not.toBeNull();
      expect(totals!.used).toBeLessThanOrEqual(totals!.total);
    }
  });

  it('returns null when the account has no credits at all', () => {
    expect(resolveCreditTotals(usage({}))).toBeNull();
  });

  it('returns null when totals are zero even though every pool is known', () => {
    expect(
      resolveCreditTotals(usage({ plan: { remaining: '0', used: '0', total: '0' } })),
    ).toBeNull();
  });

  it('returns null on a malformed pool amount rather than partially summing', () => {
    expect(
      resolveCreditTotals(
        usage({
          plan: { remaining: '38.20', used: '11.80', total: '50.00' },
          purchased: { remaining: '1', used: 'not-a-number', total: '12.00' },
        }),
      ),
    ).toBeNull();
  });

  it('returns null on a malformed remaining amount of an unknown-history pool', () => {
    expect(
      resolveCreditTotals(usage({ plan: { remaining: 'N/A', used: null, total: null } })),
    ).toBeNull();
  });

  it('returns null for a negative ledger amount', () => {
    expect(
      resolveCreditTotals(usage({ plan: { remaining: '0', used: '-1.00', total: '50.00' } })),
    ).toBeNull();
  });

  it('returns null instead of silently losing precision beyond the safe integer range', () => {
    // 账本允许 10 位整数 + 9 位小数,汇总后的 ledger units 能超过 Number.MAX_SAFE_INTEGER。
    // 那时转 number 会静默丢精度,破坏"全程 BigInt 不丢精度"的保证 —— 宁可整条不展示。
    expect(
      resolveCreditTotals(
        usage({
          plan: { remaining: '0', used: '9999999999', total: '9999999999' },
        }),
      ),
    ).toBeNull();
  });

  it('returns null when there is no usage snapshot', () => {
    expect(resolveCreditTotals(null)).toBeNull();
  });
});
