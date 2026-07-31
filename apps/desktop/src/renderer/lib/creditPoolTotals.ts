/**
 * creditPoolTotals — 把 model-access credit-usage 的额度池账本压成一条
 * 「已用 / 总额」，供右下角 chip 在 Cindy 网关形态下显示账号额度。
 *
 * 两类数据来源的可靠性不同,决定了未知池必须按余额兜底而不能跳过:
 *   - remaining / available: Gateway /balance 直接给的原值, Server 侧强校验过
 *     「三池之和 === available」(见 gateway.ts normalizeBalance), 永远有值、永远自洽。
 *   - used / total: Server 从 credit events 事件流**反推**的 —— 翻不到当期 grant 事件
 *     就是 null(订阅期末取消、从未订阅过、事件超过 pageSize 100 × MAX_PAGES 10 = 1000
 *     条被截断), 见 modelAccessCreditUsage.ts 的 planTotal / purchasedTotal 分支。
 *
 * 未知池的处理:把它的 remaining 记作该池 total、已用记 0。这样
 *
 *     Σtotal − Σused ≡ Σremaining ≡ available
 *
 * 恒成立 —— 因为已知池满足 total − used = remaining(Server 侧就是用
 * `used = total − remaining` 反推的, 见 modelAccessCreditUsage.ts:81), 未知池按定义
 * 也满足。于是 chip 上的两个数与设置页「可用余额」永远自洽。代价是未知池的已用被
 * 计为 0(低估已用), 这是账本历史缺失的固有限制, 但不会让总额偏小。
 *
 * 绝不跳过未知池 —— 那会把该池余额从总额里抹掉(实测: 订阅池 ¥1000 未知时总额从
 * ¥1594.68 掉成 ¥604), 与设置页自相矛盾。
 *
 * 账本金额是 scale=9 的十进制字符串, 汇总全程走 BigInt, 只在最后一步转成展示用的
 * number —— 不让 float 参与加法。
 */

import type { ModelAccessCreditUsage } from '../../shared/modelAccess';

/** 账本 scale=9：1 单位货币 = 1e9 ledger units。 */
const LEDGER_SCALE = 1_000_000_000n;
/** 与 BillingPage 的 ledgerUnits 同口径：整数部分 ≤10 位，小数 ≤9 位。 */
const LEDGER_PATTERN = /^(-?)(0|[1-9]\d{0,9})(?:\.(\d{1,9}))?$/;

/** 十进制账本字符串 → BigInt ledger units；格式不合法返 null。 */
function ledgerUnits(value: string): bigint | null {
  const match = LEDGER_PATTERN.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(9, '0');
  const units = BigInt(match[2]) * LEDGER_SCALE + BigInt(fraction || '0');
  return match[1] === '-' ? -units : units;
}

/**
 * ledger units → 货币单位。
 *
 * 账本允许 10 位整数 + 9 位小数，汇总后的 units 理论上能超过 Number.MAX_SAFE_INTEGER
 * (9e15)，转 number 会静默丢精度、破坏本模块"全程 BigInt 不丢精度"的保证。超出安全范围
 * 时返回 null，让调用方整条不展示，而不是给出一个悄悄错掉的金额。
 */
function toCurrency(units: bigint): number | null {
  if (units > BigInt(Number.MAX_SAFE_INTEGER) || units < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(units) / Number(LEDGER_SCALE);
}

export interface CreditTotals {
  /** 能确证的已用之和，货币单位。历史缺失的池按 0 计。 */
  used: number;
  /** 总额之和，货币单位。历史缺失的池按其当前余额计。 */
  total: number;
}

/**
 * @returns null 表示没有可展示的额度事实 —— 无快照、金额格式非法(数据不可信,
 *   整条不展示), 或总额为 0(未订阅且未充值)。
 */
export function resolveCreditTotals(
  usage: ModelAccessCreditUsage | null,
): CreditTotals | null {
  if (!usage) return null;

  let usedUnits = 0n;
  let totalUnits = 0n;

  for (const pool of [usage.plan, usage.purchased, usage.promotional]) {
    if (pool.used === null || pool.total === null) {
      // 账本历史推不出用量:按当前余额兜底(total = remaining, used = 0)。
      // 空池(remaining = 0)自然贡献 0,无需特判。
      const remaining = ledgerUnits(pool.remaining);
      if (remaining === null || remaining < 0n) return null;
      totalUnits += remaining;
      continue;
    }
    const used = ledgerUnits(pool.used);
    const total = ledgerUnits(pool.total);
    // 单个池金额格式非法 → 整条不可信, 不做部分汇总
    if (used === null || total === null || used < 0n || total < 0n) return null;
    usedUnits += used;
    totalUnits += total;
  }

  if (totalUnits === 0n) return null;
  const used = toCurrency(usedUnits);
  const total = toCurrency(totalUnits);
  if (used === null || total === null) return null;
  return { used, total };
}
