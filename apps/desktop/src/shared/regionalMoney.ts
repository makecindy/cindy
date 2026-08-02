import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from './brandRegion.js';

export type MoneyCurrency = 'CNY' | 'USD';
export type MoneyKind = 'actual-cost' | 'value-estimate';
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

export interface ModelPriceQuote {
  providerId: string;
  modelId: string;
  currency: MoneyCurrency;
  source:
    | 'gateway'
    | 'provider-reference'
    | 'subscription-reference'
    | 'user-override';
  approximate: boolean;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheCreatePerMtok?: number;
  /**
   * Context-length pricing bands. minInputTokens is inclusive and maxInputTokens
   * is exclusive; omitted prices inherit the quote's baseline field.
   */
  inputTokenPriceBands?: Array<{
    minInputTokens: number;
    maxInputTokens?: number;
    inputPerMtok?: number;
    outputPerMtok?: number;
    cacheReadPerMtok?: number;
    cacheCreatePerMtok?: number;
  }>;
  /** Gateway 声明的折扣比例；计费金额按原价 × (1 - costDiscount)。 */
  costDiscount?: number;
  /**
   * 该报价的币种不是上游声明的，而是本地按兜底链推断出来的。
   *
   * 报价数值由服务端给定、币种却由客户端猜，猜错就会把一个口径的数字盖上另一个口径的
   * 戳（既不换算也不拒收），下游账本按它记账后无从分辨。带上这个标记，金额侧才能降级
   * 成估算而不是继续冒充精确账单。
   */
  currencyInferred?: boolean;
}

export type ModelPricingCatalog = Record<string, Record<string, ModelPriceQuote>>;

/** CN 构建把其它渠道的 USD 费用统一换算为 CNY 时使用的固定汇率。 */
export const USD_TO_CNY_FIXED_RATE = 6.7;

export function gatewayCurrencyForRegion(region: CindyRegion): MoneyCurrency {
  return region === 'global' ? 'USD' : 'CNY';
}

/** 当前构建的本地 usage 账本币种。 */
export const DEFAULT_USAGE_CURRENCY: MoneyCurrency = gatewayCurrencyForRegion(CURRENT_CINDY_REGION);

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`invalid non-negative money amount: ${String(amount)}`);
  }
}

function uniqueReasons(
  reasons: ReadonlyArray<MoneyEstimateReason | undefined>,
): MoneyEstimateReason[] | undefined {
  const out = [...new Set(reasons.filter((reason): reason is MoneyEstimateReason => !!reason))];
  return out.length > 0 ? out : undefined;
}

/** Gateway 金额币种由显式 region 决定。 */
export function gatewayCurrency(region: CindyRegion): MoneyCurrency {
  return gatewayCurrencyForRegion(region);
}

/** 当前客户端本地 usage 账本的零值。 */
export function zeroUsageMoney(kind: MoneyKind = 'actual-cost'): RegionalMoney {
  return {
    amount: 0,
    currency: DEFAULT_USAGE_CURRENCY,
    approximate: kind === 'value-estimate',
    kind,
    ...(kind === 'value-estimate' ? { estimateReasons: ['subscription-value'] } : {}),
  };
}

/**
 * 把一笔 USD 金额包成 RegionalMoney,单位保持 USD 不折算。
 * actual-cost 是精确事实;value-estimate 按估算标记 approximate 并记录原因。
 */
export function usdMoney(
  amountUsd: number,
  kind: MoneyKind = 'actual-cost',
  reason?: MoneyEstimateReason,
): RegionalMoney {
  assertAmount(amountUsd);
  const approximate = kind === 'value-estimate';
  const estimateReasons = approximate ? uniqueReasons([reason, 'subscription-value']) : undefined;
  return {
    amount: amountUsd,
    currency: 'USD',
    approximate,
    kind,
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

/** 旧 *_usd 列/字段(单位本来就是 USD)的读侧投影。 */
export function legacyUsdMoney(amountUsd: number): RegionalMoney {
  return usdMoney(amountUsd);
}

/**
 * 把来源金额投影到当前区域账本。固定汇率本身不改变 approximate 语义：
 * 精确 USD 费用换算后仍直接展示，价值估算仍保留其原有估算标记。
 */
export function regionalizeMoney(money: RegionalMoney, region: CindyRegion): RegionalMoney {
  assertAmount(money.amount);
  if (region === 'global' || money.currency === 'CNY') return money;
  return {
    ...money,
    amount: money.amount * USD_TO_CNY_FIXED_RATE,
    currency: 'CNY',
  };
}

export function regionalizeUsd(
  amountUsd: number,
  region: CindyRegion,
  kind: MoneyKind = 'actual-cost',
  reason?: MoneyEstimateReason,
): RegionalMoney {
  return regionalizeMoney(usdMoney(amountUsd, kind, reason), region);
}

/**
 * 把 USD 口径金额投影到目标账本币种。
 *
 * 与 regionalizeMoney 的区别：投影目标是**账号的结算币种**而不是构建区域。本地账本是
 * 单币种的，写入侧只接受该币种（见 main/usage/ledgerCurrency），所以非 Gateway 渠道
 * （订阅价值估算、第三方供应商 SDK 费用，原始口径都是 USD）必须按账本币种投影而不是按
 * 区域 —— 否则以 USD 结算的账号在 CN 构建上会拿到 CNY 金额，被账本守卫当异币种全部丢弃，
 * 这些渠道的花费就再也记不进日账本、按模型统计与「本对话」累计。
 *
 * 只支持 USD → CNY（固定汇率本就是为这个方向的展示投影设的）。已是目标币种的原样返回；
 * CNY → USD 没有反向汇率契约，不猜、原样返回交给上层的异币种处理。
 */
export function toLedgerCurrency(
  money: RegionalMoney,
  ledgerCurrency: MoneyCurrency,
): RegionalMoney {
  assertAmount(money.amount);
  if (money.currency === ledgerCurrency) return money;
  if (ledgerCurrency === 'CNY' && money.currency === 'USD') {
    return { ...money, amount: money.amount * USD_TO_CNY_FIXED_RATE, currency: 'CNY' };
  }
  return money;
}

/** usdMoney + 按账本币种投影（替代按区域投影的 regionalizeUsd）。 */
export function usdToLedgerCurrency(
  amountUsd: number,
  ledgerCurrency: MoneyCurrency,
  kind: MoneyKind = 'actual-cost',
  reason?: MoneyEstimateReason,
): RegionalMoney {
  return toLedgerCurrency(usdMoney(amountUsd, kind, reason), ledgerCurrency);
}

/** Gateway 原生数值；缺省币种跟随本地 usage 账本，账号快照可显式传入币种。 */
export function gatewayMoney(
  amount: number,
  currency: MoneyCurrency = DEFAULT_USAGE_CURRENCY,
  kind: MoneyKind = 'actual-cost',
): RegionalMoney {
  assertAmount(amount);
  const approximate = kind === 'value-estimate';
  return {
    amount,
    currency,
    approximate,
    kind,
    ...(approximate ? { estimateReasons: ['subscription-value'] } : {}),
  };
}

export function addRegionalMoney(values: readonly RegionalMoney[]): RegionalMoney {
  if (values.length === 0) throw new Error('cannot add an empty money list');
  const currency = values[0].currency;
  if (values.some((value) => value.currency !== currency)) {
    throw new Error('cannot add money with different currencies');
  }
  for (const value of values) assertAmount(value.amount);
  const approximate = values.some((value) => value.approximate);
  const estimateReasons = uniqueReasons(values.flatMap((value) => value.estimateReasons ?? []));
  return {
    amount: values.reduce((sum, value) => sum + value.amount, 0),
    currency,
    approximate,
    kind: values.some((value) => value.kind === 'actual-cost') ? 'actual-cost' : 'value-estimate',
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

/**
 * Read-side compatibility for persisted/history projections.
 *
 * Writers must keep using addRegionalMoney() so currency drift is rejected.
 * Readers may encounter stale mixed-currency data (pre-0081 local rows or a
 * device-link peer on an older build). In that case actual cost determines the
 * currency before estimates, and the preferred currency wins when multiple
 * actual currencies exist.
 */
export function addCompatibleRegionalMoney(
  values: readonly RegionalMoney[],
  preferredCurrency: MoneyCurrency = DEFAULT_USAGE_CURRENCY,
): RegionalMoney | null {
  if (values.length === 0) return null;
  const actualValues = values.filter((value) => value.kind === 'actual-cost');
  const currencyCandidates = actualValues.length > 0 ? actualValues : values;
  const currency =
    currencyCandidates.find((value) => value.currency === preferredCurrency)?.currency ??
    currencyCandidates[0].currency;
  const compatible = values.filter((value) => value.currency === currency);
  return compatible.length > 0 ? addRegionalMoney(compatible) : null;
}

export function asValueEstimateMoney(money: RegionalMoney): RegionalMoney {
  assertAmount(money.amount);
  return {
    ...money,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: uniqueReasons([...(money.estimateReasons ?? []), 'subscription-value']),
  };
}

export function normalizeRegionalMoney(value: unknown): RegionalMoney | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<RegionalMoney>;
  if (
    !isNonNegativeAmount(raw.amount) ||
    (raw.currency !== 'CNY' && raw.currency !== 'USD') ||
    typeof raw.approximate !== 'boolean' ||
    (raw.kind !== 'actual-cost' && raw.kind !== 'value-estimate')
  ) {
    return undefined;
  }
  const estimateReasons = Array.isArray(raw.estimateReasons)
    ? uniqueReasons(
        raw.estimateReasons.filter(
          (reason): reason is MoneyEstimateReason =>
            reason === 'fixed-fx' ||
            reason === 'legacy-usd' ||
            reason === 'subscription-value' ||
            reason === 'reference-price' ||
            reason === 'inferred-currency',
        ),
      )
    : undefined;
  return {
    amount: raw.amount,
    currency: raw.currency,
    approximate: raw.approximate,
    kind: raw.kind,
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

function isNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
