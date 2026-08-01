/**
 * usageFormat — usage 相关展示格式化的共用常量与函数。
 * TodaySpendChip (右下角 chip) 与 HomeUsageDashboard (首页仪表盘) 共用,
 * 保证两处金额口径 / 文案形态一致。
 */

import { formatCompactTokens } from '@cindy/maker-shared/usage-format';

import type { RegionalMoney } from '../../shared/regionalMoney';

// token 紧凑口径由 maker-shared 提供(mobile 消息动作行同源复用),这里只再导出,
// 现有 import 路径不变。
export { formatCompactTokens };

/**
 * 软日限额系数: 月度配额 / 30 * 4.5 = 月度配额 * 0.15。
 * 给重度使用的"忙日"留 buffer (即把月配额视作可在 1/4.5 ≈ 6.67 个高强度日内集中消耗)。
 * 不是平台硬限制, 仅展示用。与 web 看板 同公式同口径。
 */
export const DAILY_SOFT_LIMIT_FACTOR = 4.5;

/** 紧凑 USD 金额: ≥1k 用 $X.Xk, 否则保留 0 位小数。 */
export function formatCompactUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/** 精确 USD 金额: < $10 保留 2 位小数 (小额可读), 其余走紧凑格式。 */
export function formatUsd(n: number): string {
  if (n < 10) return `$${n.toFixed(2)}`;
  return formatCompactUsd(n);
}

/**
 * Per-turn / per-model USD cost (MessageActionBar and its tooltip):
 * always renders two decimal places so the displayed amount matches the
 * monetary total users compare across models and turns. Values below one cent
 * retain a lower-bound label instead of misleadingly rendering as $0.00.
 */
export function formatTurnCostUsd(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return '<$0.01';
}

function moneyPrefix(money: RegionalMoney): string {
  return money.currency === 'CNY' ? '¥' : '$';
}

/** 区域金额的紧凑展示；币种来自金额本身。 */
export function formatCompactMoney(money: RegionalMoney): string {
  const prefix = moneyPrefix(money);
  if (money.amount >= 1000) return `${prefix}${(money.amount / 1000).toFixed(1)}k`;
  return `${prefix}${Math.round(money.amount)}`;
}

/** 区域金额的常规展示。 */
export function formatMoney(money: RegionalMoney): string {
  if (money.amount < 10) return `${moneyPrefix(money)}${money.amount.toFixed(2)}`;
  return formatCompactMoney(money);
}

/** 每轮 / 每模型金额：固定两位；小于最小货币展示单位时显示下界。 */
export function formatTurnCostMoney(money: RegionalMoney): string {
  const symbol = money.currency === 'CNY' ? '¥' : '$';
  if (money.amount === 0) {
    return `${symbol}0.00`;
  }
  if (money.amount >= 0.01) {
    return `${symbol}${money.amount.toFixed(2)}`;
  }
  return `<${symbol}0.01`;
}

/**
 * 把 SDK / 网关 model id 收成简短可读标签, 供 tooltip「按模型成本明细」展示。
 * 依次剥掉 SDK 路由后缀 `[..]`、尾部日期 `-YYYYMMDD`、`codex/` 预算前缀, 再美化家族名。
 * 认不出的安全回退原始 id (绝不返回空串)。
 *   'claude-opus-4-8[1m]'       → 'Opus 4.8'
 *   'claude-haiku-4-5-20251001' → 'Haiku 4.5'
 *   'gpt-5.5' / 'codex/gpt-5.5' → 'GPT-5.5'
 */
export function formatModelShort(id: string): string {
  if (typeof id !== 'string' || !id.trim()) return id;
  const s = id.trim()
    .replace(/\[[^\]]*\]\s*$/, '') // 去 [1m] 等 SDK 路由后缀
    .replace(/-\d{6,8}$/, '')      // 去尾部日期 -YYYYMMDD / -YYMMDD
    .replace(/^codex\//, '');      // 去预算路由前缀
  const claude = s.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return `${family} ${claude[2]}.${claude[3]}`;
  }
  if (/^gpt-/i.test(s)) return s.toUpperCase();
  return s || id;
}
