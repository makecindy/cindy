/**
 * 额度查询遇到 Cindy 网关 401 时上报 Cindy AI Key 失效(其余状态不上报)。
 * 只断言上报行为;配额解析契约见 claudeAccountUsageSource.test.ts。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerDisabled: false,
  outboundFetch: vi.fn(),
  report: vi.fn(),
  readOrganization: vi.fn(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (...args: unknown[]) => void } }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));
vi.mock('../../authManager', () => ({
  getAuthState: () => ({
    mode: 'cloud',
    user: { id: 'user-1', membershipKind: 'org' },
    dataOwnerId: 'user-1',
    ownerGeneration: 1,
  }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/auth-adapters', () => ({
  readClaudeApiKey: () => 'usage-key-sent',
}));
vi.mock('../../maker-host/outbound-fetch', () => ({ outboundFetch: mocks.outboundFetch }));
vi.mock('../../maker-host/runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.test.invalid',
}));
vi.mock('../modelPricing', () => ({ getGatewayAccountCurrency: async () => 'USD' }));
vi.mock('../ledgerCurrency', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../model-access/gatewayKeyRejection', () => ({
  reportCindyGatewayKeyRejected: mocks.report,
}));
vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: () => ({ disabledProviders: { xd: mocks.providerDisabled } }),
}));

// This suite exercises the explicit old-server / Nova compatibility path.
vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: mocks.readOrganization }));
let usage: typeof import('../claudeAccountUsage');
let credentials: typeof import('../../model-access/quotaCredentialState');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('claudeAccountUsage Cindy AI key rejection', () => {
  beforeAll(async () => {
    // reset-modules: load the mocked usage module once before this suite; per-test resets use its production test reset API.
    vi.resetModules();
    usage = await import('../claudeAccountUsage');
    credentials = await import('../../model-access/quotaCredentialState');
  });
  beforeEach(() => {
    mocks.providerDisabled = false;
    usage.__resetClaudeAccountUsageForTesting();
    vi.useFakeTimers();
    mocks.outboundFetch.mockReset();
    mocks.report.mockReset();
    mocks.readOrganization.mockReset().mockResolvedValue(undefined);
    mocks.windows = [];
    credentials.__resetQuotaCredentialStateForTesting('cloud:user-1:1', {
      state: 'ok', source: 'server', endpoint: 'https://gateway.test.invalid', accountTier: null,
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // Unit regression: the existing idle poll kept querying and reporting 401
  // after xd was suspended, which indirectly rotated keys in another instance.
  it('stops quota requests while disabled even when idle polling was already started', async () => {
    mocks.outboundFetch.mockImplementation(async (url: string) =>
      url.includes('/user/daily/activity')
        ? jsonResponse({ results: [] })
        : jsonResponse({ spend: 1, max_budget: 10, budget_reset_at: null }),
    );
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    mocks.outboundFetch.mockClear();
    mocks.readOrganization.mockClear();

    mocks.providerDisabled = true;
    await usage.triggerClaudeAccountUsageRefresh(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.readOrganization).not.toHaveBeenCalled();
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(usage.readClaudeAccountUsageSnapshot()).toBeNull();

    mocks.providerDisabled = false;
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    expect(usage.readClaudeAccountUsageSnapshot()?.spend).toBe(1);
  });

  it('does not start legacy gateway requests after disabling during the managed quota read', async () => {
    mocks.readOrganization.mockImplementation(async () => {
      mocks.providerDisabled = true;
      return undefined;
    });

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('shares the main-process quota read across primary and secondary window IPC senders', async () => {
    const { registerMakerUsageHandlers } = await import('../../maker-ipc/usageHandlers');
    const { IpcHarness } = await import('../../maker-ipc/__tests__/helpers/ipcHarness');
    const { MAKER_INVOKE } = await import('../../maker-ipc/channels');
    const harness = new IpcHarness();
    registerMakerUsageHandlers(harness, {
      readClaudeAccountUsageSnapshot: usage.readClaudeAccountUsageSnapshot,
      readClaudeAccountQuotaClear: usage.readClaudeAccountQuotaClear,
      triggerClaudeAccountUsageRefresh: usage.triggerClaudeAccountUsageRefresh,
    } as Parameters<typeof registerMakerUsageHandlers>[1]);
    const read = (sender: number) => harness.invokeFrom(sender, MAKER_INVOKE.USAGE_ACCOUNT, 'claude-code', 'cindy-quota-state-v1');
    const confirmations: Promise<unknown>[] = [];
    const sends = [1, 2].map(sender => vi.fn(() => { confirmations.push(read(sender)); }));
    mocks.windows = sends.map(send => ({ isDestroyed: () => false, webContents: { send } }));
    let complete!: (value: 'unlimited') => void;
    mocks.readOrganization.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = read(1);
    const second = read(2);
    let secondFinished = false;
    void second.then(() => { secondFinished = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
    expect(secondFinished).toBe(false);
    complete('unlimited');
    expect(await Promise.all([first, second])).toEqual([{ quotaState: 'unlimited' }, { quotaState: 'unlimited' }]);
    await Promise.all(confirmations);
    expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
    for (const send of sends) expect(send).toHaveBeenCalledTimes(1);
    mocks.readOrganization.mockResolvedValue('unlimited');
    await vi.advanceTimersByTimeAsync(11_000);
    await read(2);
    expect(mocks.readOrganization).toHaveBeenCalledTimes(2);
    for (const send of sends) expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports the sent key when user/info and daily/activity are rejected with 401', async () => {
    mocks.outboundFetch.mockImplementation(async () => jsonResponse({ error: 'invalid key' }, 401));

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.outboundFetch.mock.calls) {
      expect(call[1]).toMatchObject({ headers: { Authorization: 'Bearer usage-key-sent' } });
    }
    expect(mocks.report).toHaveBeenCalledTimes(2);
    expect(mocks.report).toHaveBeenNthCalledWith(1, 'usage-key-sent');
    expect(mocks.report).toHaveBeenNthCalledWith(2, 'usage-key-sent');
  });

  it('reports only the endpoint that was rejected with 401', async () => {
    mocks.outboundFetch.mockImplementation(async (url: string) =>
      url.includes('/user/daily/activity')
        ? jsonResponse({ error: 'invalid key' }, 401)
        : jsonResponse({ spend: 1, max_budget: 10, budget_reset_at: null }),
    );

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith('usage-key-sent');
  });

  it.each([403, 500])('does not report HTTP %s', async (status) => {
    mocks.outboundFetch.mockImplementation(async () => jsonResponse({ error: 'nope' }, status));

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('does not report successful quota responses', async () => {
    mocks.outboundFetch.mockImplementation(async (url: string) =>
      url.includes('/user/daily/activity')
        ? jsonResponse({ results: [] })
        : jsonResponse({ spend: 1, max_budget: 10, budget_reset_at: null }),
    );

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    expect(mocks.report).not.toHaveBeenCalled();
    // Unit compatibility: the legacy reader keeps daily data without opting in
    // to the enterprise switch (missing switch must not disable this path).
    expect(usage.readClaudeAccountUsageSnapshot()).toEqual({
      spend: 1, maxBudget: 10, currency: 'USD', budgetResetAt: null,
      todaySpend: 0, fetchedAt: expect.any(Number),
    });
  });
});
