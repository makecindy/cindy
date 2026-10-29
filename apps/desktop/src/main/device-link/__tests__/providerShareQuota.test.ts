import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  owner: 0,
  group: null as unknown,
  providers: [] as unknown[],
  snapshot: null as unknown,
  personal: false,
}));
const remote = vi.hoisted(() => vi.fn());
const readers = vi.hoisted(() => ({ claude: vi.fn(), xai: vi.fn(), codex: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(state.owner),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({
    mode: 'cloud',
    user: { membershipKind: state.personal ? 'personal' : 'organization' },
  }),
}));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: vi.fn() }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => state.providers }),
}));
vi.mock('../../maker-ipc/usage.js', () => ({
  readClaudeSubscriptionUsageSnapshotForDeviceLink: readers.claude,
  readXaiSubscriptionUsageSnapshotForDeviceLink: readers.xai,
  readCodexRateLimitsForHost: readers.codex,
}));
vi.mock('../../provider-group/managementClient.js', () => ({ invokeProviderManagement: remote }));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: () => state.group }));
const creditUsage = vi.hoisted(() => vi.fn());
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: creditUsage }));
vi.mock('../../usage/claudeAccountUsage.js', () => ({
  readClaudeAccountUsageSnapshot: () => state.snapshot,
  readClaudeAccountQuotaClear: () => null,
  triggerClaudeAccountUsageRefresh: async () => {},
}));
vi.mock('../index.js', () => ({ remoteBackgroundInvoke: vi.fn() }));
import { readProviderShareQuota, readProviderShareQuotaAccount } from '../providerShareQuota';
/* 测试价值：通过真实额度读入口验证组来源边界、展示白名单、0/缺失区分与共享缓存。
 * 旧订阅读取测试未覆盖跨账号投影；最小输入含自有+借来账号、远端多余字段、在途改组。
 * tier: unit；宿主依赖mock，无外网/Agent。单文件耗时见执行报告。 */
const ready = {
  state: 'ready',
  updatedAt: 1,
  windows: [],
  balance: { remaining: 0, total: 100, currency: 'USD', resetsAt: null, pools: [] },
};
beforeEach(() => {
  state.owner++;
  state.personal = false;
  state.group = null;
  state.providers = [{ id: 'xd', connected: true, auth: { method: 'apiKey' } }];
  state.snapshot = null;
  remote.mockReset().mockResolvedValue(ready);
});
describe('share quota projection', () => {
  it('distinguishes real zero from unavailable and unsupported sources', async () => {
    state.snapshot = { fetchedAt: 1, maxBudget: 100, spend: 100, currency: 'USD' };
    expect(await readProviderShareQuotaAccount('xd')).toMatchObject({
      state: 'ready',
      balance: { remaining: 0 },
    });
    state.owner++;
    state.snapshot = null;
    expect(await readProviderShareQuotaAccount('xd')).toMatchObject({
      state: 'unavailable',
      balance: null,
    });
    state.providers = [{ id: 'custom', connected: true, auth: { method: 'apiKey' } }];
    expect(await readProviderShareQuotaAccount('custom')).toMatchObject({
      state: 'unsupported',
      balance: null,
    });
  });
  it('projects personal Cindy credit pools without grants or account details', async () => {
    state.personal = true;
    creditUsage.mockResolvedValue({
      available: '7',
      scale: 9,
      observedAt: '2026-10-19T00:00:00Z',
      ledgerUpdatedAt: null,
      plan: { remaining: '4', used: '6', total: '10' },
      purchased: { remaining: '3', used: null, total: null },
      promotional: { remaining: '0', used: '0', total: '0' },
      promotionalGrants: [],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED',
      email: 'private@example.test',
    });
    const result = await readProviderShareQuotaAccount('xd');
    expect(result).toMatchObject({
      state: 'ready',
      balance: {
        remaining: 7,
        total: null,
        pools: [
          { kind: 'plan', remaining: 4, total: 10 },
          { kind: 'purchased', remaining: 3, total: null },
          { kind: 'promotional', remaining: 0, total: 0 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/email|promotionalGrants|private/);
  });
  it('uses the existing subscription window reader without forwarding account identity', async () => {
    state.providers = [
      {
        id: 'anthropic',
        connected: true,
        source: 'builtin',
        auth: { method: 'oauth', native: 'claude' },
      },
    ];
    readers.claude.mockResolvedValue({
      fiveHour: { utilization: 100, resetsAt: Date.now() + 60_000 },
      updatedAt: 123,
      accountFingerprint: 'secret',
    });
    const result = await readProviderShareQuotaAccount('anthropic');
    expect(result).toMatchObject({
      state: 'ready',
      updatedAt: 123,
      windows: [{ kind: 'session', remainingPercent: 0, windowMinutes: 300 }],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('excludes borrowed accounts and strips remote identity fields while coalescing repeated queries', async () => {
    state.group = {
      members: [
        { kind: 'device', agentDeviceId: 'own-device', providerId: 'xd' },
        { kind: 'share', agentDeviceId: 'share:borrowed', providerId: 'xd' },
      ],
    };
    remote.mockResolvedValue({
      ...ready,
      deviceId: 'secret',
      email: 'private@example.test',
      balance: { ...ready.balance, credential: 'secret' },
    });
    const [first, second] = await Promise.all([
      readProviderShareQuota('xd'),
      readProviderShareQuota('xd'),
    ]);
    expect(first).toEqual({ group: true, partial: true, accounts: [ready] });
    expect(second).toEqual(first);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0][1]).toBe('own-device');
    expect(JSON.stringify(first)).not.toMatch(/secret|email|deviceId|credential/);
  });
  it.each([
    ['[UNSUPPORTED_CAPABILITY]', 'needs-update'],
    ['[DEVICE_LINK_DEVICE_OFFLINE]', 'offline'],
  ])('keeps a distinct state for %s', async (message, expected) => {
    state.group = { members: [{ kind: 'device', agentDeviceId: 'd', providerId: 'xd' }] };
    remote.mockRejectedValue(new Error(message));
    expect((await readProviderShareQuota('xd')).accounts[0].state).toBe(expected);
  });
  it('discards group results when membership changes in flight', async () => {
    state.group = { members: [{ kind: 'device', agentDeviceId: 'd', providerId: 'xd' }] };
    remote.mockImplementation(async () => {
      state.group = { members: [] };
      return ready;
    });
    await expect(readProviderShareQuota('xd')).rejects.toThrow('PRECONDITION_FAILED');
  });
});
