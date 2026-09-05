export type RemoteMoneyCurrency = 'CNY' | 'USD';
export type RemoteMoneyEstimateReason =
  | 'fixed-fx'
  | 'legacy-usd'
  | 'subscription-value'
  | 'reference-price'
  | 'inferred-currency'
  | 'sdk-estimate';

/** Desktop 经 device-link 下发的结构化金额。 */
export interface RemoteMoney {
  amount: number;
  currency: RemoteMoneyCurrency;
  approximate: boolean;
  kind: 'actual-cost' | 'value-estimate';
  estimateReasons?: RemoteMoneyEstimateReason[];
}

export function normalizeRemoteMoney(value: unknown): RemoteMoney | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<RemoteMoney>;
  if (
    typeof raw.amount !== 'number'
    || !Number.isFinite(raw.amount)
    || raw.amount < 0
    || (raw.currency !== 'CNY' && raw.currency !== 'USD')
    || typeof raw.approximate !== 'boolean'
    || (raw.kind !== 'actual-cost' && raw.kind !== 'value-estimate')
  ) {
    return null;
  }
  const estimateReasons = Array.isArray(raw.estimateReasons)
    ? raw.estimateReasons.filter(
        (reason): reason is RemoteMoneyEstimateReason =>
          reason === 'fixed-fx' ||
          reason === 'legacy-usd' ||
          reason === 'subscription-value' ||
          reason === 'reference-price' ||
          reason === 'inferred-currency' ||
          reason === 'sdk-estimate',
      )
    : undefined;
  return {
    amount: raw.amount,
    currency: raw.currency,
    approximate: raw.approximate,
    kind: raw.kind,
    ...(estimateReasons?.length ? { estimateReasons: [...new Set(estimateReasons)] } : {}),
  };
}

export function remoteMoneySymbol(currency: RemoteMoneyCurrency): '¥' | '$' {
  return currency === 'CNY' ? '¥' : '$';
}
