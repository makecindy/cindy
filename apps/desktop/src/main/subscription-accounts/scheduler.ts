import type { ProviderGroupMemberQuota } from '../../shared/providerGroup.js';

/** Recovery eligibility only. New assignment still uses the official group/pool picker. */
export function subscriptionWindowRoom(windows: readonly ProviderGroupMemberQuota[] | null): boolean {
  return !!windows?.length && windows.every(window =>
    window.usedPercent < (window.windowMs <= 5 * 3_600_000 ? 85 : 95));
}
