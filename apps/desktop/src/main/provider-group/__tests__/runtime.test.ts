/**
 * 运行期单例按账号隔离：换账号后冷却、目录缓存不沿用上一个账号的。
 */
import { describe, expect, it, vi } from 'vitest';

let owner = 'owner-a';

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => owner }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: vi.fn(() => []) }));
vi.mock('../../device-link/ipc.js', () => ({ handleListDevices: vi.fn(async () => ({ devices: [] })), defaultDeps: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ remoteBackgroundInvoke: vi.fn() }));
vi.mock('../../device-link/controllerPlatform.js', () => ({ isMobilePlatform: () => false }));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'This computer' }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: vi.fn(async () => []) }),
}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: vi.fn(async () => []) }));
vi.mock('../bindings.js', () => ({ listProviderGroupBindings: () => ({}) }));
vi.mock('../store.js', () => ({ readProviderGroup: () => null }));

const { getProviderGroupDirectory, getProviderGroupOwnerScope, getProviderGroupRouter } = await import('../runtime.js');

describe('provider group runtime', () => {
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
