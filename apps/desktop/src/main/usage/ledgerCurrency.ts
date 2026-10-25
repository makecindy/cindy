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
import {createLedgerCurrency} from "@cindy/app-runtime/ledgerCurrency";


export const {LEDGER_CURRENCY_FALLBACK,setActiveLedgerCurrency,hydrateLastKnownLedgerCurrency,resetLedgerCurrencyForAccountSwitch,currentLedgerCurrency,isLedgerCurrencyKnown,__resetActiveLedgerCurrencyForTesting}=createLedgerCurrency({

});
