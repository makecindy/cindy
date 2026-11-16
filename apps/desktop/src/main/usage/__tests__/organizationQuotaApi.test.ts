import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), readKey: vi.fn(), outbound: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(),
  broadcast: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  auth: { mode: 'cloud', dataOwnerId: 'owner-a', ownerGeneration: 1, user: { id: 'member-a', membershipKind: 'org' } },
}));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../authManager', () => ({ getAuthState: () => mocks.auth, getAccessToken: () => 'fixture-token', refresh: mocks.refresh, invalidateSession: mocks.invalidate }));
vi.mock('../../logger', () => ({ createLogger: () => ({ error: mocks.error, warn: mocks.warn, debug: mocks.debug }) }));
vi.mock('../../i18n.desktop.js', () => ({ getResolvedMainLocale: () => 'en' }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://models.example.test' }));
vi.mock('../../maker-host/auth-adapters', () => ({ readClaudeApiKey: mocks.readKey }));
vi.mock('../../maker-host/outbound-fetch.desktop', () => ({ outboundFetch: mocks.outbound }));
vi.mock('../../maker-host/runtime-configs', () => ({ claudeUpstreamEndpoint: () => 'https://gateway.example.test' }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: mocks.broadcast }));
vi.mock('../modelPricing', () => ({ getGatewayAccountCurrency: async () => 'CNY' }));
vi.mock('../ledgerCurrency', () => ({ currentLedgerCurrency: () => 'CNY' }));
import * as usage from '../claudeAccountUsage';
import { __resetQuotaCredentialStateForTesting } from '../../model-access/quotaCredentialState';
import { readOrganizationAccountUsage } from '../organizationAccountUsage';
const valid = { spend: 12, maxBudget: 100, currency: 'CNY', budgetResetAt: null, dailyLimitEnabled: true, todaySpend: 2 };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  usage.__resetClaudeAccountUsageForTesting();
  __resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'idle', source: null, endpoint: null, accountTier: null });
  vi.useFakeTimers(); vi.resetAllMocks();
  mocks.auth = { mode: 'cloud', dataOwnerId: 'owner-a', ownerGeneration: 1, user: { id: 'member-a', membershipKind: 'org' } };
  mocks.readKey.mockReturnValue(null);
  mocks.refresh.mockResolvedValue(false);
  mocks.fetch.mockResolvedValue(jsonResponse(valid));
});
afterEach(() => { usage.__resetClaudeAccountUsageForTesting(); vi.useRealTimers(); });

// Unit regression: invoke the production refresh through the real serverApiClient
// and simulated Electron HTTP exit. Old 404/501 handling read the inference Key;
// parser-only mocks could not catch that fallback. No real network or credentials.
// Minimal input: signed-in org, no synced credentials, unsupported /quota response.
describe('quota through real server API client', () => {
  it('reads quota with login authentication before inference credentials exist', async () => {
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(usage.readClaudeAccountUsageSnapshot()).toEqual({ ...valid, fetchedAt: expect.any(Number) });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://models.example.test/api/model-access/quota', expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
    }));
    expect(mocks.readKey).not.toHaveBeenCalled();
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it.each([
    [404, 'NOT_FOUND'], [501, 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED'], [501, 'OTHER_UNSUPPORTED'],
    [503, 'UPSTREAM_ERROR'], [401, 'TOKEN_EXPIRED'],
  ])('keeps status %s (%s) unavailable without reading a gateway Key or calling its management APIs', async (status, code) => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: { code, message: 'private-upstream-detail' } }, status));
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(usage.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(usage.readClaudeAccountQuotaClear()).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.readKey).not.toHaveBeenCalled();
    expect(mocks.outbound).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(JSON.stringify([mocks.error.mock.calls, mocks.warn.mock.calls, mocks.debug.mock.calls])).not.toContain('private-upstream-detail');
    if (status === 401) expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({ serverRejectedToken: true });
  });
  it.each([404, 501, 503, 401])('preserves a same-owner finite snapshot after HTTP %s', async status => {
    await usage.triggerClaudeAccountUsageRefresh(true);
    const snapshot = usage.readClaudeAccountUsageSnapshot();
    mocks.broadcast.mockClear();
    mocks.fetch.mockResolvedValue(jsonResponse({ error: { code: 'ERROR' } }, status));
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(usage.readClaudeAccountUsageSnapshot()).toBe(snapshot);
    expect(usage.readClaudeAccountQuotaClear()).toBeNull();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
  it('keeps the cached quota when the request exceeds its 8 second deadline', async () => {
    await usage.triggerClaudeAccountUsageRefresh(true);
    const snapshot = usage.readClaudeAccountUsageSnapshot();
    mocks.broadcast.mockClear();
    mocks.fetch.mockImplementationOnce((_url: string, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => reject(new Error('private-upstream-detail')), { once: true });
    }));
    const pending = usage.triggerClaudeAccountUsageRefresh(true);
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(usage.readClaudeAccountUsageSnapshot()).toBe(snapshot);
    expect(usage.readClaudeAccountQuotaClear()).toBeNull();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(mocks.readKey).not.toHaveBeenCalled();
    expect(mocks.outbound).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private-upstream-detail');
  });
  it.each(['local', 'personal'])('stops enterprise quota requests in %s mode even with an existing idle poll', async mode => {
    await usage.triggerClaudeAccountUsageRefresh(true);
    mocks.fetch.mockClear();
    if (mode === 'local') mocks.auth.mode = 'local';
    else mocks.auth.user.membershipKind = 'personal';
    await usage.triggerClaudeAccountUsageRefresh(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.readKey).not.toHaveBeenCalled();
    expect(mocks.outbound).not.toHaveBeenCalled();
    expect(usage.readClaudeAccountUsageSnapshot()).toBeNull();
  });
  it('treats malformed success data as unavailable', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ ...valid, currency: 'unknown' }));
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
});
