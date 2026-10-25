export type MoneyCurrency = 'CNY' | 'USD';
export type MoneyKind = 'actual-cost' | 'value-estimate';
export type PriceVariant = 'standard' | 'priority' | 'fast' | 'batch' | 'ultrafast';
export type MoneyEstimateReason =
  'fixed-fx' | 'legacy-usd' | 'subscription-value' | 'reference-price' | 'inferred-currency';

/**
 * 用量/费用金额始终携带币种。当前构建的本地账本使用区域币种:
 * - Cindy AI Gateway:CN 原生 CNY,Global 原生 USD,数值不做二次换算;
 * - 其它渠道的 USD 费用进入 CN 账本前按固定汇率换成 CNY;
 * - 历史结构化金额保持原样,不在读侧猜测或回填。
 */
export interface RegionalMoney {
  amount: number;
  currency: MoneyCurrency;
  approximate: boolean;
  kind: MoneyKind;
  estimateReasons?: MoneyEstimateReason[];
}

