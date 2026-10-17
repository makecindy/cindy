import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import type { ClaudeAccountUsageSnapshot } from './claudeAccountUsage.js';

/** undefined means legacy gateway/server; null means unavailable, with no credential fallback. */
export async function readOrganizationAccountUsage(): Promise<ClaudeAccountUsageSnapshot | 'unlimited' | null | undefined> {
  try {
    const data = await serverApiFetch<unknown>('/api/model-access/quota', {
      baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      timeoutMs: 8000, redactErrorDetails: true,
      allowedRedactedErrorCodes: ['MODEL_ACCESS_QUOTA_NOT_SUPPORTED'],
    });
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
    if (error instanceof ServerApiError && (error.statusCode === 404 ||
      (error.statusCode === 501 && error.code === 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED'))) return undefined;
    return null;
  }
}
