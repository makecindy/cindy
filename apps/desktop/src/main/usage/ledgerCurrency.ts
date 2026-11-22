/**
 * The Gateway catalog supplies the account settlement currency. The last known
 * currency survives catalog refreshes and is the default view for mixed usage.
 * Provider prices and SDK receipts retain their own currencies.
 */

import type { MoneyCurrency } from '../../shared/regionalMoney.js';

/**
 * 三级回退的最后一档。取 USD 的理由见文件头 —— 不要改成 DEFAULT_USAGE_CURRENCY，
 * 那正是本次修复要消灭的「按区域猜」。
 */
export const LEDGER_CURRENCY_FALLBACK: MoneyCurrency = 'USD';

let active: MoneyCurrency | null = null;
let lastKnown: MoneyCurrency | null = null;

/**
 * 记录当前账号的账本币种。传 null 表示本次同步没能确认（登出、切号、目录尚未同步，
 * 或目录出现混合币种因而不可信）—— 只清 active，不清 lastKnown。
 */
export function setActiveLedgerCurrency(currency: MoneyCurrency | null): void {
  active = currency;
  if (currency) lastKnown = currency;
}

/**
 * 启动时从磁盘快照恢复「上次已知」。只在尚无已知值时生效，绝不覆盖本进程已经确认过的
 * 币种 —— 磁盘快照可能比当前登录账号旧。
 */
export function hydrateLastKnownLedgerCurrency(currency: MoneyCurrency | null): void {
  if (currency && !lastKnown) lastKnown = currency;
}

/**
 * 切号时丢掉「上次已知」。
 *
 * lastKnown 的作用是熬过同一账号的瞬时未知，跨账号沿用就变成了记错账：新账号的目录
 * 若恰好没声明币种，会静默继承上一个账号的结算币种。账号边界一到就必须清零，让回退
 * 链重新从这个账号自己的持久化值开始。
 */
export function resetLedgerCurrencyForAccountSwitch(): void {
  active = null;
  lastKnown = null;
}

/** 账本写入与聚合应当使用的币种。回退链见文件头。 */
export function currentLedgerCurrency(): MoneyCurrency {
  return active ?? lastKnown ?? LEDGER_CURRENCY_FALLBACK;
}

/**
 * 账本币种是否有据可依（而非落到最后一档兜底）。
 *
 * 调用方据此决定「这一笔要不要标成估算」：兜底值是猜的，按它记的账不该冒充精确账单。
 */
export function isLedgerCurrencyKnown(): boolean {
  return active !== null || lastKnown !== null;
}

/** 仅测试：重置为未知。 */
export function __resetActiveLedgerCurrencyForTesting(): void {
  active = null;
  lastKnown = null;
}
