import type { SubscriptionAccountUsage, SubscriptionProvider } from '../../shared/subscriptionAccounts.js';

export const SUBSCRIPTION_USAGE_TTL_MS = 180_000;

/** Public quota projection. Never spread native account/usage objects across the plugin boundary. */
export function subscriptionUsageView(input: {
  providerId: string;
  provider: SubscriptionProvider;
  accountId: string;
  authenticated: boolean;
  unavailable?: boolean;
  plan?: string;
  planTier?: string;
  planType?: string;
  usage?: SubscriptionAccountUsage;
  updatedAt?: number;
}, now: number) {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const timestamp = (value: unknown): number | null => {
    const result = number(value);
    return result !== null && result > 0 ? result : null;
  };
  const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
  const windows: { id: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; updatedAt: number | null }[] = [];
  const usage = input.authenticated && !input.unavailable ? input.usage : undefined;
  const claude = usage?.claude;
  const updatedAt = timestamp(claude?.updatedAt) ?? timestamp(input.updatedAt);
  const add = (id: string, used: unknown, minutes: number | null, reset: unknown, observedAt: unknown) => {
    const percent = number(used);
    windows.push({ id, usedPercent: percent === null ? null : Math.min(100, Math.max(0, percent)),
      windowMinutes: number(minutes), resetsAt: timestamp(reset), updatedAt: timestamp(observedAt) });
  };
  if (claude) {
    if (claude.fiveHour) add('five_hour', claude.fiveHour.utilization, 300, claude.fiveHour.resetsAt, updatedAt);
    if (claude.sevenDay) add('seven_day', claude.sevenDay.utilization, 10080, claude.sevenDay.resetsAt, updatedAt);
    for (const window of claude.scoped ?? []) {
      add(`weekly:${window.modelId || window.modelDisplayName}`, window.utilization, 10080, window.resetsAt, updatedAt);
    }
  }
  for (const [id, bucket] of Object.entries(usage?.codex?.buckets ?? {})) {
    for (const key of ['primary', 'secondary'] as const) {
      const window = bucket[key];
      if (window) add(`${id}:${key}`, window.usedPercent, window.windowMinutes, window.resetsAt, bucket.updatedAt);
    }
  }
  const observed = windows.flatMap(window => window.updatedAt === null ? [] : [window.updatedAt]);
  const lastUpdated = windows.length ? observed.length ? Math.max(...observed) : updatedAt : null;
  return {
    providerId: input.providerId, provider: input.provider, accountId: input.accountId,
    status: input.unavailable ? 'unavailable' : input.authenticated ? 'connected' : 'signed-out',
    plan: { type: text(input.planType) ?? text(input.plan), tier: text(input.planTier) },
    windows, updatedAt: lastUpdated,
    usageStatus: !windows.length ? 'unavailable' : lastUpdated === null
      || windows.some(window => window.updatedAt === null || now - window.updatedAt >= SUBSCRIPTION_USAGE_TTL_MS
        || (window.resetsAt !== null && window.resetsAt * 1000 <= now)) ? 'stale' : 'available',
  };
}
