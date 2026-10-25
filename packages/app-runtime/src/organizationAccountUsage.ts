
import type { ClaudeAccountUsageSnapshot } from './claudeAccountUsage.js';
export interface createOrganizationAccountUsageHost {fetchQuota():Promise<unknown>;isLegacyQuotaError(error:unknown):boolean;}

export function createOrganizationAccountUsage(host:createOrganizationAccountUsageHost) {



/** undefined means legacy gateway/server; null means unavailable, with no credential fallback. */
async function readOrganizationAccountUsage(): Promise<ClaudeAccountUsageSnapshot | 'unlimited' | null | undefined> {
  try {
    const data = await host.fetchQuota();
    if (!data || typeof data !== 'object') return null;
    const row = data as Record<string, unknown>;
    if (typeof row.spend !== 'number' || !Number.isFinite(row.spend) || row.spend < 0 ||
      (row.maxBudget !== null && (typeof row.maxBudget !== 'number' || !Number.isFinite(row.maxBudget) || row.maxBudget <= 0)) ||
      (row.currency !== 'CNY' && row.currency !== 'USD') ||
      (row.budgetResetAt !== null && (typeof row.budgetResetAt !== 'string' || !Number.isFinite(Date.parse(row.budgetResetAt))))) return null;
    if (row.maxBudget === null) return 'unlimited';
    return { spend: row.spend, maxBudget: row.maxBudget, currency: row.currency,
      budgetResetAt: row.budgetResetAt, todaySpend: null, fetchedAt: Date.now() };
  } catch (error) {
    if (host.isLegacyQuotaError(error)) return undefined;
    return null;
  }
}
return {
  readOrganizationAccountUsage
};
}
