import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MENUBAR_SETTINGS, type MenubarHelperMessage } from '../../../shared/menubarQuota';
import { emptyMenubarInputs } from '../collect';
import * as subscriptions from '../../device-link/subscriptions';
const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  auth: { mode: 'cloud', dataOwnerId: 'owner', ownerGeneration: 1, user: { id: 'member', membershipKind: 'org' } },
  revision: 0, listeners: new Set<() => void>(), refresh: vi.fn(), collect: vi.fn(),
  quota: null as null | { spend: number; maxBudget: number; currency: string; fetchedAt: number; todaySpend: null },
  attentionCount: 0, attentionListeners: new Set<(count: number) => void>(), publish: vi.fn(),
  openRemoteSettings: vi.fn(), onHelperMessage: null as null | ((message: MenubarHelperMessage) => void),
}));
vi.mock('electron', () => ({ app: mocks.app, Notification: class {} }));
vi.mock('../../agent-island/service.js', () => ({ getAgentIslandService: () => ({
  getAttentionCount: () => mocks.attentionCount,
  subscribeAttentionCount: (listener: (count: number) => void) => {
    mocks.attentionListeners.add(listener);
    return () => mocks.attentionListeners.delete(listener);
  },
  subscribeSessionActivity: () => () => {},
}) }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: true }) }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => ({ dataOwnerId: 'owner', mode: 'cloud', generation: mocks.auth.ownerGeneration }), isAppSessionBoundaryPending: () => false }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => mocks.auth, onAuthStateChange: () => () => {} }));
vi.mock('../../billing/projection.js', () => ({}));
vi.mock('../../clientEndpointsService.js', () => ({}));
vi.mock('../../deepLink.js', () => ({ openMainWindowRemoteControlSettings: mocks.openRemoteSettings }));
vi.mock('../../device-link/index.js', () => ({}));
vi.mock('../../device-link/dispatch.js', () => ({ getActiveControllers: () => subscriptions.getControlControllers() }));
vi.mock('../../device-link/ipc.js', () => ({}));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'Fixture' }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en', mainStringKeysUnder: () => [], rawMainString: (key: string) => key }));
vi.mock('../../localDb/ipc/sessions.js', () => ({}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({}));
vi.mock('../../maker-ipc/appDefaultModelControl.js', () => ({}));
vi.mock('../../maker-ipc/register.js', () => ({}));
vi.mock('../../maker-ipc/usage.js', () => ({}));
vi.mock('../../notificationService.js', () => ({}));
vi.mock('../../serverApiClient.js', () => ({}));
vi.mock('../../usage/claudeAccountUsage.js', () => ({ readClaudeAccountUsageRevision: () => mocks.revision, observeClaudeAccountUsage: (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; }, triggerClaudeAccountUsageRefresh: () => mocks.refresh(), readClaudeAccountUsageSnapshot: () => mocks.quota }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../usage/usageHistory.js', () => ({}));
vi.mock('../../usageBroadcaster.js', () => ({ observeUsageChanges: () => () => {} }));
vi.mock('../settingsStore.js', () => ({ readMenubarSettings: () => ({ ...DEFAULT_MENUBAR_SETTINGS }), writeMenubarSettings: (value: unknown) => value }));
vi.mock('../MacMenubarNativeHost.js', () => ({ MacMenubarNativeHost: class {
  constructor(options: { onMessage: (message: MenubarHelperMessage) => void }) { mocks.onHelperMessage = options.onMessage; }
  resetFailure() {} prepare() {} suspend() {} stop() {} publish(view: unknown) { mocks.publish(view); }
} }));
vi.mock('../creditSamples.js', () => ({ CreditSampleStore: class { record() { return []; } }, estimateDailyBurn: () => null }));
vi.mock('../collect.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../collect')>(), collectMenubarInputs: (...args: unknown[]) => mocks.collect(...args) }));
import { MenubarService } from '../service';
beforeEach(() => {
  mocks.app.isPackaged = true;
  vi.useFakeTimers(); mocks.revision = 0; mocks.listeners.clear(); mocks.refresh.mockReset(); mocks.collect.mockReset();
  mocks.attentionCount = 0; mocks.attentionListeners.clear(); mocks.publish.mockReset();
  mocks.openRemoteSettings.mockReset(); mocks.onHelperMessage = null;
  subscriptions.__testing.reset();
  mocks.quota = { spend: 2, maxBudget: 10, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Unit: unread updates bypass slow usage collection, survive rebuilds and detach on stop.
it('updates the native count immediately while a usage rebuild is still pending', async () => {
  const service = new MenubarService({ openNewTask() {} });
  const collected = emptyMenubarInputs(Date.now(), 'Fixture');
  mocks.attentionCount = 2;
  subscriptions.subscribe('phone', ['session:chat']);
  mocks.collect.mockResolvedValue(collected);
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 2, remotelyControlled: true }));
  let resolve!: (value: typeof collected) => void;
  mocks.collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  service.refreshLocalization();
  await vi.advanceTimersByTimeAsync(0);
  mocks.attentionCount = 0;
  for (const listener of mocks.attentionListeners) listener(0);
  subscriptions.clearAll();
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 0, remotelyControlled: false }));
  resolve(collected);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 0, remotelyControlled: false }));
  service.stop();
  expect(mocks.attentionListeners.size).toBe(0);
});

// Unit regression: dev builds forced the native indicator on with no controllers.
// Existing coverage only used packaged builds; exercise the published state in both modes.
it.each([true, false])('lights only for active controllers and clears on exit (packaged=%s)', async (isPackaged) => {
  mocks.app.isPackaged = isPackaged;
  const service = new MenubarService({ openNewTask() {} });
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  subscriptions.subscribe('phone', ['sessions', 'fs-watch:/repo']);
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remotelyControlled: false }));
  subscriptions.subscribe('phone', ['session:chat']);
  subscriptions.updateControllerMetadata('phone', 'Dash’s iPhone');
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remotelyControlled: true, remoteControllerNames: ['Dash’s iPhone'] }));
  subscriptions.updateControllerMetadata('phone', 'Travel iPhone');
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remoteControllerNames: ['Travel iPhone'] }));
  mocks.onHelperMessage?.({ type: 'open-remote-control-settings' });
  expect(mocks.openRemoteSettings).toHaveBeenCalledOnce();
  mocks.publish.mockClear();
  subscriptions.subscribe('mac', ['*']);
  subscriptions.updateControllerMetadata('mac', 'MacBook Air');
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remoteControllerNames: ['Travel iPhone', 'MacBook Air'] }));
  subscriptions.clearController('phone');
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remotelyControlled: true, remoteControllerNames: ['MacBook Air'] }));
  mocks.publish.mockClear();
  service.refreshControlState();
  expect(mocks.publish).not.toHaveBeenCalled();
  subscriptions.clearController('mac');
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ remotelyControlled: false, remoteControllerNames: [] }));
  service.stop();
});
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
