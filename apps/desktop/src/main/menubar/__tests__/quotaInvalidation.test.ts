import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { mode: 'cloud', dataOwnerId: 'owner', ownerGeneration: 1, user: { id: 'member', membershipKind: 'org' } },
  revision: 0, listeners: new Set<() => void>(), refresh: vi.fn(), collect: vi.fn(),
  quota: null as null | { spend: number; maxBudget: number; currency: string; fetchedAt: number; todaySpend: null },
}));
vi.mock('electron', () => ({ app: {}, Notification: class {} }));
vi.mock('../../agent-island/service.js', () => ({ getAgentIslandService: () => null }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: true }) }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => ({ dataOwnerId: 'owner', mode: 'cloud', generation: mocks.auth.ownerGeneration }), isAppSessionBoundaryPending: () => false }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => mocks.auth, onAuthStateChange: () => () => {} }));
vi.mock('../../billing/projection.js', () => ({}));
vi.mock('../../clientEndpointsService.js', () => ({}));
vi.mock('../../deepLink.js', () => ({}));
vi.mock('../../device-link/index.js', () => ({}));
vi.mock('../../device-link/ipc.js', () => ({}));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'Fixture' }));
vi.mock('../../i18n.js', () => ({}));
vi.mock('../../localDb/ipc/sessions.js', () => ({}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({}));
vi.mock('../../maker-ipc/appDefaultModelControl.js', () => ({}));
vi.mock('../../maker-ipc/register.js', () => ({}));
vi.mock('../../maker-ipc/usage.js', () => ({}));
vi.mock('../../notificationService.js', () => ({}));
vi.mock('../../serverApiClient.js', () => ({}));
vi.mock('../../usage/claudeAccountUsage.js', () => ({ readClaudeAccountUsageRevision: () => mocks.revision, observeClaudeAccountUsage: (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; }, triggerClaudeAccountUsageRefresh: () => mocks.refresh(), readClaudeAccountUsageSnapshot: () => mocks.quota }));
vi.mock('../../usage/ledgerCurrency.js', () => ({}));
vi.mock('../../usage/usageHistory.js', () => ({}));
vi.mock('../../usageBroadcaster.js', () => ({ observeUsageChanges: () => () => {} }));
vi.mock('../settingsStore.js', () => ({ readMenubarSettings: () => ({ enabled: true }), writeMenubarSettings: (value: unknown) => value }));
vi.mock('../MacMenubarNativeHost.js', () => ({ MacMenubarNativeHost: class { resetFailure() {} prepare() {} suspend() {} stop() {} } }));
vi.mock('../creditSamples.js', () => ({ CreditSampleStore: class { record() { return []; } }, estimateDailyBurn: () => null }));
vi.mock('../collect.js', () => ({ collectMenubarInputs: (...args: unknown[]) => mocks.collect(...args) }));
import { MenubarService } from '../service';
beforeEach(() => {
  vi.useFakeTimers(); mocks.revision = 0; mocks.listeners.clear(); mocks.refresh.mockReset(); mocks.collect.mockReset();
  mocks.quota = { spend: 2, maxBudget: 10, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function clearQuota() {
  mocks.quota = null; mocks.revision++;
  for (const listener of mocks.listeners) listener();
}
it.each(['unlimited', 'invalidated'])('evicts cached quota and schedules rebuilding on %s clear', async () => {
  const service = new MenubarService({ openNewTask() {} });
  const schedule = vi.spyOn(service as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  service.init();
  expect((await service['readBalance'](false, Date.now()))?.available).toBe(8);
  schedule.mockClear();
  clearQuota();
  expect(schedule).toHaveBeenCalledWith(0);
  expect(await service['readBalance'](false, Date.now())).toBeNull();
  service.stop(); expect(mocks.listeners.size).toBe(0);
});
it('rejects the cache even when the clear happened while the menu bar was stopped', async () => {
  const service = new MenubarService({ openNewTask() {} });
  expect((await service['readBalance'](false, Date.now()))?.available).toBe(8);
  clearQuota();
  expect(await service['readBalance'](false, Date.now())).toBeNull();
});
it('does not restore the captured cache after an in-flight read fails across clear', async () => {
  const service = new MenubarService({ openNewTask() {} });
  await service['readBalance'](false, Date.now());
  let reject!: (error: Error) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  const pending = service['readBalance'](true, Date.now());
  clearQuota(); reject(new Error('unavailable'));
  expect(await pending).toBeNull();
  expect(await service['readBalance'](false, Date.now())).toBeNull();
});
it('does not publish a view collected before clear', async () => {
  const service = new MenubarService({ openNewTask() {} });
  const schedule = vi.spyOn(service as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  const publish = vi.spyOn(service as never, 'publish' as never).mockImplementation(() => undefined);
  service.init();
  let resolve!: (value: unknown) => void;
  mocks.collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = service['collectAndPublish'](Date.now(), false, () => {});
  clearQuota(); resolve({}); await pending;
  expect(publish).not.toHaveBeenCalled(); expect(schedule).toHaveBeenCalledWith(0);
  service.stop();
});

it('rebuilds when finite quota arrives after invalidation cached a temporary null', async () => {
  const service = new MenubarService({ openNewTask() {} });
  const schedule = vi.spyOn(service as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  service.init();
  expect((await service['readBalance'](false, Date.now()))?.available).toBe(8);
  clearQuota();
  expect(await service['readBalance'](false, Date.now())).toBeNull();
  schedule.mockClear();
  mocks.quota = { spend: 3, maxBudget: 20, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
  expect(schedule).toHaveBeenCalledWith(0);
  expect((await service['readBalance'](false, Date.now()))?.available).toBe(17);
  service.stop();
});
