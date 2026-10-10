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

/**
 * 任务累计金额:优先结构化 totalMoney(区域币种),回退旧 Desktop 的 USD 账本;
 * 两者都缺或为 0(如订阅模式)时返回 null,调用方不显示。
 */
export function resolveSessionTotalMoney(session: {
  totalMoney?: unknown;
  totalCostUsd?: unknown;
}): RemoteMoney | null {
  const totalMoney = normalizeRemoteMoney(session.totalMoney);
  if (totalMoney && totalMoney.amount > 0) return totalMoney;
  const legacy = session.totalCostUsd;
  return typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0
    ? { amount: legacy, currency: 'USD', approximate: false, kind: 'actual-cost' }
    : null;
}

export function formatRemoteMoney(money: RemoteMoney): string {
  const symbol = remoteMoneySymbol(money.currency);
  if (money.amount >= 10) return `${symbol}${Math.round(money.amount)}`;
  if (money.amount >= 0.01) return `${symbol}${money.amount.toFixed(2)}`;
  return `<${symbol}0.01`;
}
