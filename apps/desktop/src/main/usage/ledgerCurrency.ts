/**
 * 当前登录账号的本地账本币种（单一事实源）。
 *
 * 为什么不能用构建区域(DEFAULT_USAGE_CURRENCY)代替：结算币种由服务端按账号所属租户
 * 下发，不保证与客户端发行区域一致 —— 例如某些组织账号会以 USD 结算，而客户端可能是
 * CN 构建。这是完全正常的组合，按区域判会把这些账号的每一笔都当成异币种拒收，
 * 等于这些用户完全不计费。
 *
 * 值由模型目录同步时写入(见 usage/modelPricing.replaceGatewayModelPricing)——报价币种
 * 就是该账号的结算币种。
 *
 * ## 三级回退，且绝不按区域猜
 *
 *   active（本次同步刚确认） → lastKnown（本进程或磁盘上见过的最后一次） → USD
 *
 * `active` 会因为完全正常的原因反复变成未知：目录同步在途、缓存 scope 失效、登出重登。
 * 一旦这些瞬时状态回落到构建区域，同一账号的账本币种就会在 USD / CNY 之间来回翻 ——
 * 而下游账本是单币种的，翻转会让金额被拒收或让当天累计被覆盖。所以未知时优先沿用
 * 已知过的值：币种是账号属性，比任何一次同步都稳定。
 *
 * 最终兜底取 USD 而不是构建区域币种：USD 是 SDK 自报费用与全部参考价表的原生口径，
 * 兜底成 USD 最多是币种符号显示得不合预期，兜底成 CNY 却会把 USD 数值原样盖上 CNY 戳
 * （既不换算也不拒收），产生 6.7 倍量级的错账。宁可显示得保守，不可记错。
 *
 * 本模块刻意零依赖(只引 shared 类型)：账本写入层(localDb/dailySpend、
 * localDb/dailyModelUsage、sessionSpendBroadcaster)和报价层都要用它，
 * 走这里可以避免两边互相 import 成环。持久化由 usage/accountCurrencyStore 负责，
 * 它在启动时把上次已知值 hydrate 回来。
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
