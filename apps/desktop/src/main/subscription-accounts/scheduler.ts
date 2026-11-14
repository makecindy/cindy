import type { ProviderGroupMemberQuota, ProviderGroupStrategy } from '../../shared/providerGroup.js';
import { pickProviderGroupMember, type PickOptions, type SchedulableMember } from '../provider-group/scheduler.js';

export interface SubscriptionSchedulableMember extends SchedulableMember {
  windows: readonly ProviderGroupMemberQuota[] | null;
}

/** Leave headroom for an unpredictable next turn; this is no token-to-quota conversion. */
export function subscriptionWindowPressure(windows: readonly ProviderGroupMemberQuota[] | null): boolean {
  return !!windows?.some(w => w.usedPercent >= (w.windowMs <= 5 * 3_600_000 ? 85 : 95));
}

export function subscriptionWindowRoom(windows: readonly ProviderGroupMemberQuota[] | null): boolean {
  return !!windows?.length && !subscriptionWindowPressure(windows);
}

/**
 * Useful independent work should reach each safe idle account before piling more on a busy one.
 * Remaining load follows quota pace per active root; the user's policy breaks similar scores.
 * External provider-group routing keeps its existing policy. No synthetic work or fixed shares.
 */
export function pickSubscriptionAccountMember(
  members: readonly SubscriptionSchedulableMember[], strategy: ProviderGroupStrategy, options: PickOptions = {},
): string | null {
  const open = members.filter(m => m.usable && !m.paused && !options.exclude?.has(m.key) && m.running < m.limit);
  const roomy = open.filter(m => subscriptionWindowRoom(m.windows));
  // If every account is near its headroom threshold, prefer an actually remaining plan window
  // over an exhausted one, even when that exhausted short window is about to reset.
  const remaining = roomy.length ? roomy : open.filter(m => !!m.windows?.length && m.windows.every(w => w.usedPercent < 100));
  // Keep the existing upstream/credits admission fallback when no known roomy account exists.
  if (!remaining.length) return pickProviderGroupMember(members, strategy, options);
  const idle = remaining.filter(m => m.running === 0);
  const candidates = (idle.length ? idle : remaining).map(m => ({
    ...m, urgency: typeof m.urgency === 'number' ? m.urgency / (m.running + 1) : null,
  }));
  return pickProviderGroupMember(candidates, strategy, options);
}
