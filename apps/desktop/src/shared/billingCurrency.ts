import { CURRENT_CINDY_REGION } from './brandRegion.js';

/**
 * 计费面的币种由发行区域决定（服务端下发的金额本身不带币种）。所有展示余额 /
 * 充值金额的界面必须用同一个常量，否则同一笔钱会在两个界面显示成不同货币
 * （见 TodaySpendChip 的「与账单页 BILLING_CURRENCY 同一笔钱、必须同口径」注释）。
 * 主进程读礼品卡响应时也用它校验币种，与界面展示同一口径。
 */
export const BILLING_CURRENCY = CURRENT_CINDY_REGION === 'global' ? 'usd' : 'cny';
