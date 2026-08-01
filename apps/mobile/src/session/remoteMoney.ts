export type RemoteMoneyCurrency = 'CNY' | 'USD';

/** Desktop 经 device-link 下发的结构化金额。 */
export interface RemoteMoney {
  amount: number;
  currency: RemoteMoneyCurrency;
  approximate: boolean;
  kind: 'actual-cost' | 'value-estimate';
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
  return {
    amount: raw.amount,
    currency: raw.currency,
    approximate: raw.approximate,
    kind: raw.kind,
  };
}

export function remoteMoneySymbol(currency: RemoteMoneyCurrency): '¥' | '$' {
  return currency === 'CNY' ? '¥' : '$';
}
