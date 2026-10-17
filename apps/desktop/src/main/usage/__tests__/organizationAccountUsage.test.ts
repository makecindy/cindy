import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: fetch, ServerApiError: class extends Error { constructor(public code: string, public statusCode: number) { super(code); } } }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://models.example.test' }));
import { ServerApiError } from '../../serverApiClient.js';
import { readOrganizationAccountUsage } from '../organizationAccountUsage';
const valid = { spend: 12, maxBudget: 100, currency: 'CNY', budgetResetAt: '2026-11-01T00:00:00Z', todaySpend: null };
beforeEach(() => { fetch.mockReset().mockResolvedValue(valid); });
describe('organization account usage', () => {
  it('uses authenticated Model Access and preserves the gateway currency', async () => {
    expect(await readOrganizationAccountUsage()).toMatchObject(valid);
    expect(fetch).toHaveBeenCalledWith('/api/model-access/quota', expect.objectContaining({ redactErrorDetails: true, timeoutMs: 8000 }));
  });
  it.each([[404, 'NOT_FOUND'], [501, 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED']])('allows legacy fallback only for an unavailable capability', async (status, code) => {
    fetch.mockRejectedValue(new ServerApiError(code, status, 'safe'));
    expect(await readOrganizationAccountUsage()).toBeUndefined();
  });
  it.each([401, 403, 429, 500, 503])('never falls back after status %s', async status => {
    fetch.mockRejectedValue(new ServerApiError('ERROR', status, 'safe'));
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
  it('distinguishes unlimited from an unavailable response', async () => {
    fetch.mockResolvedValue({ ...valid, maxBudget: null });
    expect(await readOrganizationAccountUsage()).toBe('unlimited');
  });
  it.each([{ ...valid, spend: NaN }, { ...valid, currency: 'unknown' }])('does not invent a finite quota for malformed or unlimited data', async data => {
    fetch.mockResolvedValue(data);
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
});
