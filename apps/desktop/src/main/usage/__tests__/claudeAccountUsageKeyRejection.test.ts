/**
 * Unit: production refresh and IPC regressions for disabled idle polling and
 * concurrent windows. A quota read used to rotate inference Keys on 401; quota
 * now uses Model Access. Keep the polling/clear-loop coverage after retiring it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerDisabled: false,
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
vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: () => ({ disabledProviders: { xd: mocks.providerDisabled } }),
}));

vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: mocks.readOrganization }));
import * as usage from '../claudeAccountUsage';
import * as credentials from '../../model-access/quotaCredentialState';
const quota = { spend: 1, maxBudget: 10, currency: 'USD', todaySpend: null, dailyLimitEnabled: false, fetchedAt: 1 };

describe('claudeAccountUsage polling and concurrent IPC', () => {
  beforeEach(() => {
    mocks.providerDisabled = false;
    usage.__resetClaudeAccountUsageForTesting();
    vi.useFakeTimers();
    mocks.readOrganization.mockReset().mockResolvedValue(quota);
    mocks.windows = [];
    credentials.__resetQuotaCredentialStateForTesting('cloud:user-1:1', {
      state: 'ok', source: 'server', endpoint: 'https://gateway.test.invalid', accountTier: null,
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // Unit regression: the existing idle poll kept querying and reporting 401
  // after xd was suspended, which indirectly rotated keys in another instance.
  it('stops quota requests while disabled even when idle polling was already started', async () => {
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
    mocks.readOrganization.mockClear();

    mocks.providerDisabled = true;
    await usage.triggerClaudeAccountUsageRefresh(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.readOrganization).not.toHaveBeenCalled();
    expect(usage.readClaudeAccountUsageSnapshot()).toBeNull();

    mocks.providerDisabled = false;
    await usage.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.readOrganization).toHaveBeenCalledTimes(1);
    expect(usage.readClaudeAccountUsageSnapshot()?.spend).toBe(1);
  });

  it('discards a quota result when disabled during its read', async () => {
    mocks.readOrganization.mockImplementation(async () => {
      mocks.providerDisabled = true;
      return quota;
    });

    await usage.triggerClaudeAccountUsageRefresh(true);

    expect(usage.readClaudeAccountUsageSnapshot()).toBeNull();
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
});
