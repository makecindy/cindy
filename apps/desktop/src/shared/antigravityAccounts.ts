import type { SubscriptionCodexUsageBucket } from './subscriptionAccounts.js';

export const ANTIGRAVITY_ACCOUNTS_CHANNEL = 'maker:antigravity-accounts';
export const ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID = 'google-antigravity-subscription';
export const ANTIGRAVITY_ACCOUNT_BUSY = 'ANTIGRAVITY_ACCOUNT_BUSY';

export type AntigravityAccountCommand =
  | { action: 'read' | 'install' | 'configure' | 'add' | 'usage' }
  | { action: 'select' | 'remove'; id: string };

export interface AntigravityOwnerScope {
  dataOwnerId: string | null;
  ownerGeneration: number;
}

export interface AntigravityLoginTarget extends AntigravityOwnerScope {
  accountId: string;
}

export interface AntigravityAccountsView {
  configured: boolean;
  connected: boolean;
  activeId: string | null;
  accounts: Array<{ id: string; identity?: string }>;
  usage?: SubscriptionCodexUsageBucket[];
}

/** Google supplies the model group in its display name. The bucket ID can be an index. */
export function preferredAntigravityBuckets(buckets: readonly SubscriptionCodexUsageBucket[]) {
  const gemini = buckets.filter(bucket => /\bgemini\b/i.test(bucket.limitName ?? ''));
  return gemini.length > 0 ? gemini : buckets;
}

type AntigravityQuotaWindow = NonNullable<SubscriptionCodexUsageBucket['primary']> & { usedPercent: number };

export function summarizeAntigravityQuota(
  buckets: readonly SubscriptionCodexUsageBucket[],
  nowMs: number,
) {
  const windows: Record<'primary' | 'secondary', AntigravityQuotaWindow | null> = {
    primary: null,
    secondary: null,
  };
  // Select the family before checking expiry so an elapsed Gemini window cannot
  // be mistaken for a still-live Claude allowance.
  for (const bucket of preferredAntigravityBuckets(buckets)) {
    for (const key of ['primary', 'secondary'] as const) {
      const window = bucket[key];
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      if (window.resetsAt && window.resetsAt > 0 && window.resetsAt * 1000 <= nowMs) continue;
      const best = windows[key];
      if (!best || window.usedPercent > best.usedPercent) {
        windows[key] = { ...window, usedPercent: window.usedPercent };
      }
    }
  }
  return windows;
}
