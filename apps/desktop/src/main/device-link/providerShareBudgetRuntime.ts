import type { ProviderView } from '@cindy/model-providers';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getProviderShareHostSnapshot } from './providerShareHost.js';
import { getProviderShareUsageStore, providerUsageLocalDay, providerShareUsageRangeStart } from './providerShareUsageStore.js';
import { remoteModelAccess } from './remoteModelAccess.js';
import { createMemberBudgetService } from './providerShareBudgetService.js';

/** Any provider with a member ledger, including groups, uses the same ratio. */
export function supportsMemberBudget(_provider: ProviderView): boolean { return true; }

const service = createMemberBudgetService({
  readPolicy: (providerId, memberId) => remoteModelAccess.read(providerId, memberId).memberBudget,
  readUsage(providerId, memberId) {
    const shares = getProviderShareHostSnapshot().filter(share => share.providerId === providerId
      && share.members.some(member => member.memberId === memberId));
    const now = Date.now();
    const date = new Date(now);
    const snapshot = getProviderShareUsageStore()?.memberTokenSnapshot(new Set(shares.map(share => share.shareId)), providerId, memberId, now)
      ?? { available: false, models: [], windowStart: providerShareUsageRangeStart('7d', now)!,
        windowEnd: providerUsageLocalDay(now), nextWindowAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() };
    if (!shares.length) snapshot.available = false;
    return snapshot;
  },
  modelAvailable(providerId, memberId, model) {
    const provider = getActiveCatalog().providers.find(item => item.id === providerId);
    return Object.values(provider?.models ?? {}).some(models => models?.some(item => item.id === model && !item.disabled))
      && remoteModelAccess.allows(providerId, model, memberId);
  },
});
export const readMemberBudgetStatus = service.status;
export const memberBudgetAllowsCached = service.allows;
export const memberBudgetDenial = service.denial;
export const assertMemberBudget = service.assertAllowed;
export async function memberBudgetAllows(providerId: string, model: string, memberId?: string): Promise<boolean> {
  return service.allows(providerId, model, memberId);
}
