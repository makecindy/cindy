import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MENUBAR_SETTINGS, type MenubarHelperMessage } from '../../../shared/menubarQuota';
import { emptyMenubarInputs } from '../collect';
import * as subscriptions from '../../device-link/subscriptions';
import type { AgentIslandSessionSnapshot } from '../../../shared/agentIsland';
const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  auth: { mode: 'cloud', dataOwnerId: 'owner', ownerGeneration: 1, user: { id: 'member', membershipKind: 'org' } },
  revision: 0, listeners: new Set<() => void>(), refresh: vi.fn(), collect: vi.fn(),
  quota: null as null | { spend: number; maxBudget: number; currency: string; fetchedAt: number; todaySpend: null },
  activities: [] as AgentIslandSessionSnapshot[], attentionListeners: new Set<() => void>(), publish: vi.fn(),
  openOverviewSession: vi.fn(), openLocalSession: vi.fn(),
  openRemoteSettings: vi.fn(), onHelperMessage: null as null | ((message: MenubarHelperMessage) => void),
}));
vi.mock('electron', () => ({ app: mocks.app, Notification: class {} }));
vi.mock('../../agent-island/service.js', () => ({ getAgentIslandService: () => ({
  getTaskOverview: () => mocks.activities,
  openTaskOverviewSession: mocks.openOverviewSession,
  subscribeTaskOverview: (listener: () => void) => {
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
vi.mock('../../deepLink.js', () => ({ openMainWindowRemoteControlSettings: mocks.openRemoteSettings, openMainWindowSession: mocks.openLocalSession }));
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
vi.mock('../settingsStore.js', () => ({ readMenubarSettings: () => ({ ...DEFAULT_MENUBAR_SETTINGS }), writeMenubarSettings: (value: object) => ({ ...DEFAULT_MENUBAR_SETTINGS, ...value }) }));
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
  mocks.activities = []; mocks.attentionListeners.clear(); mocks.publish.mockReset();
  mocks.openOverviewSession.mockReset(); mocks.openLocalSession.mockReset();
  mocks.openRemoteSettings.mockReset(); mocks.onHelperMessage = null;
  subscriptions.__testing.reset();
  mocks.quota = { spend: 2, maxBudget: 10, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Unit: unread updates bypass slow usage collection, survive rebuilds and detach on stop.
it('updates the native count immediately while a usage rebuild is still pending', async () => {
  const service = new MenubarService({ openNewTask() {} });
  const collected = emptyMenubarInputs(Date.now(), 'Fixture');
  mocks.activities = [activity('one'), activity('two')];
  subscriptions.subscribe('phone', ['session:chat']);
  mocks.collect.mockResolvedValue(collected);
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 2, remotelyControlled: true }));
  let resolve!: (value: typeof collected) => void;
  mocks.collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  service.refreshLocalization();
  await vi.advanceTimersByTimeAsync(0);
  mocks.activities = [];
  for (const listener of mocks.attentionListeners) listener();
  subscriptions.clearAll();
  service.refreshControlState();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 0, remotelyControlled: false }));
  resolve(collected);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 0, remotelyControlled: false }));
  service.stop();
  expect(mocks.attentionListeners.size).toBe(0);
});

function activity(sessionId: string): AgentIslandSessionSnapshot {
  return {
    sessionId, title: sessionId, projectName: null, detail: 'Latest reply', compactDetail: 'Latest reply',
    messagePreview: { id: 'reply', kind: 'assistant', text: 'Latest reply' }, phase: 'completed',
    agentKind: 'codex', permissionAction: null, attention: true, activityLines: [], startedAt: 1, lastActivityAt: 2,
  };
}

// Unit: the old count-only subscription misses content changes and cannot route remote companions.
it('updates same-count unread content immediately and opens through the island handoff', async () => {
  const service = new MenubarService({ openNewTask() {} });
  mocks.activities = [activity('remote-companion')];
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  mocks.activities = [{ ...activity('remote-companion'), messagePreview: { id: 'new', kind: 'assistant', text: 'New reply' } }];
  for (const listener of mocks.attentionListeners) listener();
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 1,
    activities: [expect.objectContaining({ sessionId: 'remote-companion', preview: 'New reply' })],
  }));
  expect(mocks.activities[0]?.attention).toBe(true);
  mocks.onHelperMessage?.({ type: 'open-session', sessionId: 'remote-companion' });
  expect(mocks.openOverviewSession).toHaveBeenCalledWith('remote-companion');
  expect(mocks.openLocalSession).not.toHaveBeenCalled();
  mocks.onHelperMessage?.({ type: 'open-session', sessionId: 'usage-only' });
  expect(mocks.openLocalSession).toHaveBeenCalledWith('usage-only');
  service.stop();
});

// Unit: privacy applies to live message previews as well as the older usage list.
it('masks companion names and message bodies in privacy mode', async () => {
  const service = new MenubarService({ openNewTask() {} });
  mocks.activities = [{ ...activity('companion'), companion: { name: 'Private name', hue: 'blue', glyph: 'P', glyphIsInitial: true } }];
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  mocks.onHelperMessage?.({ type: 'settings', patch: { privacy: true } });
  await vi.advanceTimersByTimeAsync(0);
  const view = mocks.publish.mock.calls.at(-1)?.[0];
  expect(view.activities[0]).toMatchObject({ title: 'menubar.ui.privateCompanion', preview: 'menubar.ui.activityCompleted' });
  expect(JSON.stringify(view)).not.toContain('Private name');
  expect(JSON.stringify(view)).not.toContain('Latest reply');
  service.stop();
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
