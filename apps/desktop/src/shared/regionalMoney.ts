export type MoneyCurrency = 'CNY' | 'USD';
export type MoneyKind = 'actual-cost' | 'value-estimate';
export type MoneyEstimateReason =
  'fixed-fx' | 'legacy-usd' | 'subscription-value' | 'reference-price';

/**
 * 用量/费用金额永远携带自己的币种(单位跟随数据来源,构建区域不参与):
 * - Gateway(LiteLLM)同步的 spend / 价格数值原生口径是 USD;服务端未声明币种时
 *   一律按 USD 记账与展示,绝不按区域改标或按固定汇率折算。
 * - 服务端将来在契约里声明币种(如 model-groups 条目的 currency 字段)时,以声明为准。
 * - CNY 只会来自「来源本身就是 CNY」的金额;历史上被错标/折算的 CNY 数据由
 *   migration 0081 修复,读侧仍保留跨币种兼容(device-link 对端可能是旧版本)。
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
  source: 'gateway' | 'provider-reference' | 'subscription-reference';
  approximate: boolean;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheCreatePerMtok?: number;
}

export type ModelPricingCatalog = Record<string, Record<string, ModelPriceQuote>>;

/**
 * 仅供读取历史数据兼容用:2026-07 曾按此固定汇率把 USD 金额折算成 CNY 落盘/投影,
 * 逆推这批历史数据时使用。禁止再用它产生新的折算金额。
 */
export const USD_TO_CNY_FIXED_RATE = 6.7;

/** Gateway 未声明币种时的原生记账单位(LiteLLM spend / per-token 价格口径)。 */
export const GATEWAY_NATIVE_CURRENCY: MoneyCurrency = 'USD';

/**
 * 零值与读侧聚合 preferred 的默认币种。与 Gateway 原生单位一致;当前所有金额
 * 来源(Gateway 价格、LiteLLM spend、订阅参考价)都是 USD。
 */
export const DEFAULT_USAGE_CURRENCY: MoneyCurrency = 'USD';

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

/** Gateway 金额的币种:以服务端声明为准,未声明按原生 USD。 */
export function gatewayCurrency(
  declared?: MoneyCurrency | null,
): MoneyCurrency {
  return declared ?? GATEWAY_NATIVE_CURRENCY;
}

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
  const estimateReasons = approximate
    ? uniqueReasons([reason, 'subscription-value'])
    : undefined;
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

export function gatewayMoney(
  amount: number,
  kind: MoneyKind = 'actual-cost',
  declaredCurrency?: MoneyCurrency | null,
): RegionalMoney {
  assertAmount(amount);
  const approximate = kind === 'value-estimate';
  return {
    amount,
    currency: gatewayCurrency(declaredCurrency),
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
            reason === 'reference-price',
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
