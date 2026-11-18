import { serverApiFetch } from '../serverApiClient.desktop.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import type { ClaudeAccountUsageSnapshot } from './claudeAccountUsage.js';

/** Model Access is the only quota source; null means unavailable. */
export async function readOrganizationAccountUsage(): Promise<ClaudeAccountUsageSnapshot | 'unlimited' | null> {
  try {
    const data = await serverApiFetch<unknown>('/api/model-access/quota', {
      baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      timeoutMs: 8000, redactErrorDetails: true,
    });
    if (!data || typeof data !== 'object') return null;
    const row = data as Record<string, unknown>;
    if (typeof row.spend !== 'number' || !Number.isFinite(row.spend) || row.spend < 0 ||
      (row.maxBudget !== null && (typeof row.maxBudget !== 'number' || !Number.isFinite(row.maxBudget) || row.maxBudget <= 0)) ||
      (row.currency !== 'CNY' && row.currency !== 'USD') ||
      (row.budgetResetAt !== null && (typeof row.budgetResetAt !== 'string' || !Number.isFinite(Date.parse(row.budgetResetAt))))) return null;
    if (row.maxBudget === null) return 'unlimited';
    const dailyLimitEnabled = row.dailyLimitEnabled === true;
    const todaySpend = dailyLimitEnabled && typeof row.todaySpend === 'number' && Number.isFinite(row.todaySpend) && row.todaySpend >= 0
      ? row.todaySpend : null;
    return { spend: row.spend, maxBudget: row.maxBudget, currency: row.currency,
      budgetResetAt: row.budgetResetAt, todaySpend, dailyLimitEnabled, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}
