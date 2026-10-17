/**
 * 运行期单例按账号隔离：换账号后冷却、目录缓存不沿用上一个账号的。
 */
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';

let owner = 'owner-a';
const io = vi.hoisted(() => ({
  local: vi.fn(async () => [] as ProviderView[]),
  devices: vi.fn(),
  catalog: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => owner }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: vi.fn(() => []) }));
vi.mock('../../device-link/ipc.js', () => ({ handleListDevices: io.devices, defaultDeps: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ remoteBackgroundInvoke: io.invoke }));
vi.mock('../../device-link/controllerPlatform.js', () => ({ isMobilePlatform: () => false }));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'This computer' }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: io.local }),
}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: io.catalog }));
vi.mock('../bindings.js', () => ({ listProviderGroupBindings: () => ({}) }));
vi.mock('../store.js', () => ({ readProviderGroup: () => null }));
vi.mock('../coolingStore.js', () => ({ readProviderGroupCooling: () => ({}), writeProviderGroupCooling: vi.fn() }));

const { getProviderGroupDirectory, getProviderGroupOwnerScope, getProviderGroupRouter, setProviderGroupClaudeUsageReader } = await import('../runtime.js');

afterEach(() => setProviderGroupClaudeUsageReader(null));

describe('provider group runtime', () => {
  it('keeps the affected model through the runtime facade', () => {
    owner = 'model-cooldown-owner';
    const router = getProviderGroupRouter();
    const until = Date.now() + 86_400_000;
    router.markCooling('anthropic', 'local', until, 'claude-fable-5');
    expect(router.coolingUntil('anthropic', 'local', 'fable')).toBe(until);
    expect(router.coolingUntil('anthropic', 'local', 'opus')).toBeNull();
    expect(router.coolingUntil('anthropic', 'local')).toBeNull();
  });
  it('does not return the previous owner’s details after an account change', async () => {
    owner = 'detail-owner';
    const scope = getProviderGroupOwnerScope();
    const read = vi.spyOn(scope.router, 'view').mockImplementationOnce(async (providerId) => {
      owner = 'next-detail-owner';
      return {
        providerId, config: { strategy: 'least', autoSwitch: true, members: [] },
        members: [{ key: 'local', kind: 'local', label: 'private', state: 'available', running: 0, limit: 4, weight: 1, paused: false }],
      };
    });
    expect(await getProviderGroupRouter().view('anthropic', { includeGuestSupport: true }))
      .toEqual({ providerId: 'anthropic', config: null, members: [] });
    read.mockRestore();
  });

  it('keeps cooling and round state per account behind stable handles', () => {
    const router = getProviderGroupRouter();
    expect(getProviderGroupRouter()).toBe(router);
    expect(getProviderGroupDirectory()).toBe(getProviderGroupDirectory());

    router.markCooling('anthropic', 'local', Date.now() + 60_000);
    router.markTried('s1', 'local');
    expect(router.coolingUntil('anthropic', 'local')).not.toBeNull();

    owner = 'owner-b';
    expect(router.coolingUntil('anthropic', 'local')).toBeNull();
    expect(router.triedThisTurn('s1').size).toBe(0);
  });

  it('keeps an assignment on the account it started with, even after switching accounts', () => {
    owner = 'owner-c';
    const scope = getProviderGroupOwnerScope();
    expect(scope.isCurrent()).toBe(true);
    owner = 'owner-d';
    expect(scope.isCurrent()).toBe(false);
    // 换账号之后才记上的占用落在 owner-c 那份里，owner-d 看不到。
    scope.externalLoad.recordPick('laptop', 's1', 'anthropic', 'local');
    expect(scope.externalLoad.running('anthropic', 'local')).toBe(1);
    expect(getProviderGroupOwnerScope().externalLoad.running('anthropic', 'local')).toBe(0);
  });
});

describe('provider group runtime quota account selection', () => {
  let sequence = 0;
  const usage = () => ({
    updatedAt: Date.now(), fiveHour: { utilization: 25, resetsAt: Date.now() / 1000 + 3600 },
    sevenDay: { utilization: 45, resetsAt: Date.now() / 1000 + 86400 },
  });

  function harness(providerId = 'anthropic-second') {
    owner = `quota-owner-${++sequence}`;
    const provider = (id: string) => ({ id, connected: true, auth: { method: 'oauth', native: 'claude' } }) as ProviderView;
    io.local.mockResolvedValue([provider('anthropic-local')]);
    io.catalog.mockResolvedValue([provider(providerId)]);
    io.devices.mockResolvedValue({ devices: [{ deviceId: 'mini', name: 'mini', online: true,
      remoteControlEnabled: true, controlEnabled: true, isSelf: false, platform: 'darwin' }] });
    io.invoke.mockReset();
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' },
      { kind: 'device', agentDeviceId: 'mini', providerId }] }, 'anthropic-local')!;
    const read = () => getProviderGroupDirectory().resolveMembers('anthropic-local', config);
    return { read };
  }

  it('uses each member’s provider ID through the injected reader and existing same-account channel', async () => {
    const h = harness();
    const local = vi.fn(async () => usage());
    setProviderGroupClaudeUsageReader(local);
    io.invoke.mockResolvedValue({ ok: true, result: { ...usage(), providerId: 'anthropic-second' } });
    const resolved = await h.read();
    expect(local).toHaveBeenCalledExactlyOnceWith('anthropic-local');
    expect(io.invoke).toHaveBeenCalledExactlyOnceWith('mini', 'maker:usage:claude-subscription', ['anthropic-second'],
      { preSend: expect.any(Function) });
    expect(resolved.map((r) => r.claudeUsage?.sevenDay?.utilization)).toEqual([45, 45]);
  });

  it.each([
    ['anthropic-second', undefined, false],
    ['anthropic-second', 'anthropic', false],
    ['anthropic', undefined, true],
  ])('does not use an old peer’s default quota for %s (echo %s)', async (providerId, echoed, accepted) => {
    const h = harness(providerId);
    io.invoke.mockResolvedValue({ ok: true, result: { ...usage(), ...(echoed ? { providerId: echoed } : {}) } });
    const resolved = await h.read();
    expect(resolved[1].claudeUsage !== null).toBe(accepted);
  });

  it('guards the outgoing request and discards the reply when the owner account changes', async () => {
    const h = harness();
    let preSend!: () => void;
    io.invoke.mockImplementation(async (_device, _channel, _args, options) => {
      preSend = options.preSend;
      preSend();
      owner = 'next-owner';
      return { ok: true, result: { ...usage(), providerId: 'anthropic-second' } };
    });
    const resolved = await h.read();
    expect(resolved[1].claudeUsage).toBeNull();
    expect(() => preSend()).toThrow('provider group account changed');
  });
});
