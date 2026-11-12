import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import type { SubscriptionAccountUsage } from '../../../shared/subscriptionAccounts';

/** Presentation only: never grants an account or changes runtime admission. */
export function modelAccountQuotaStatus(providerId: string, usage: SubscriptionAccountUsage | null, now: number) {
  const claude = providerId === 'anthropic' ? usage?.claude : null;
  const bucket = providerId === 'openai' ? matchCodexBucketForModel(usage?.codex?.buckets, undefined, now) : null;
  const windows = claude
    ? [
        { used: claude.fiveHour?.utilization, reset: claude.fiveHour?.resetsAt, short: true,
          rejected: claude.rateLimitStatus === 'rejected' && claude.representativeClaim === 'five_hour' },
        { used: claude.sevenDay?.utilization, reset: claude.sevenDay?.resetsAt, short: false,
          rejected: claude.rateLimitStatus === 'rejected' && claude.representativeClaim === 'seven_day' },
      ]
    : [bucket?.primary, bucket?.secondary].filter(w => w && (w.windowMinutes === 300 || w.windowMinutes === 10080))
        .map(w => ({ used: w!.usedPercent, reset: w!.resetsAt, short: w!.windowMinutes === 300, rejected: false }));
  const validReset = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const short = windows.find(w => w.short);
  const fiveHourRemaining = short && Number.isFinite(short.used)
    && (!validReset(short.reset) || short.reset * 1000 > now)
    ? Math.round(100 - Math.max(0, Math.min(100, short.used!))) : null;
  const exhausted = windows.filter(w => w.rejected || (Number.isFinite(w.used) && w.used! >= 100));
  const limited = exhausted.length > 0;
  const reset = limited && exhausted.every(w => validReset(w.reset))
    ? Math.max(...exhausted.map(w => w.reset!)) : null;
  return {
    limited,
    pending: reset !== null && reset * 1000 <= now,
    reset,
    fiveHourRemaining,
    fiveHourExhausted: exhausted.some(w => w.short),
    low: !limited && short !== undefined && Number.isFinite(short.used) && short.used! >= 90
      && fiveHourRemaining !== null,
  };
}

/** A pool warns only when every known member is exhausted; an unknown member is not proof. */
export function modelQuotaWarning(members: ReturnType<typeof modelAccountQuotaStatus>[]) {
  if (!members.length) return null;
  if (members.every(m => m.limited)) {
    const pending = members.some(m => m.pending);
    return { kind: 'limited' as const, pending,
      reset: !pending && members.every(m => m.reset !== null) ? Math.min(...members.map(m => m.reset!)) : null };
  }
  return members.length === 1 && members[0].low
    ? { kind: 'low' as const, remaining: members[0].fiveHourRemaining } : null;
}
