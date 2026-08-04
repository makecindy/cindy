/**
 * 当前登录账号的本地账本币种（单一事实源）。
 *
 * 为什么不能用构建区域(DEFAULT_USAGE_CURRENCY)代替：结算币种由服务端按账号所属租户
 * 下发，不保证与客户端发行区域一致 —— 例如某些组织账号会以 USD 结算，而客户端可能是
 * CN 构建。这是完全正常的组合，按区域判会把这些账号的每一笔都当成异币种拒收，
 * 等于这些用户完全不计费。
 *
 * 值由模型目录同步时写入(见 usage/modelPricing.replaceGatewayModelPricing)——报价币种
 * 就是该账号的结算币种。登出 / 切号 / 清空报价时置为未知，读侧回落构建默认值。
 *
 * 本模块刻意零依赖(只引 shared 常量)：账本写入层(localDb/dailySpend、
 * localDb/dailyModelUsage、sessionSpendBroadcaster)和报价层都要用它，
 * 走这里可以避免两边互相 import 成环。
 */

import { DEFAULT_USAGE_CURRENCY, type MoneyCurrency } from '../../shared/regionalMoney.js';

let active: MoneyCurrency | null = null;

/**
 * 记录当前账号的账本币种。传 null 表示未知（登出、切号、目录尚未同步，
 * 或目录出现混合币种因而不可信），此时读侧回落构建默认值。
 */
export function setActiveLedgerCurrency(currency: MoneyCurrency | null): void {
  active = currency;
}

/**
 * 账本写入与聚合应当使用的币种。未知时回落构建默认值 —— 冷启动首帧、纯订阅账号
 * (没有 Gateway 报价)都走这条，与历史行为一致。
 */
export function currentLedgerCurrency(): MoneyCurrency {
  return active ?? DEFAULT_USAGE_CURRENCY;
}

/** 仅测试：重置为未知。 */
export function __resetActiveLedgerCurrencyForTesting(): void {
  active = null;
}
