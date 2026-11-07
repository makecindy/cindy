import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MENUBAR_SETTINGS, type MenubarHelperMessage } from '../../../shared/menubarQuota';
import { emptyMenubarInputs } from '../collect';
import * as subscriptions from '../../device-link/subscriptions';
import type { AgentIslandSessionSnapshot } from '../../../shared/agentIsland';
const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  auth: { mode: 'cloud', dataOwnerId: 'owner' as string | null, ownerGeneration: 1, user: { id: 'member', membershipKind: 'org' } },
  authListeners: new Set<(state: { isAuthenticated: boolean }) => void>(), boundaryPending: false,
  sharedRead: vi.fn(), sharedChanged: null as null | (() => void), sharedAccessEpoch: 0,
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
vi.mock('../../appSessionState.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return { ...actual,
    getActiveAppSession: () => ({ dataOwnerId: mocks.auth.dataOwnerId, mode: mocks.auth.mode, generation: mocks.auth.ownerGeneration }),
    isAppSessionBoundaryPending: () => mocks.boundaryPending || actual.isAppSessionBoundaryPending(),
  };
});
vi.mock('../../authManager.js', () => ({ getAuthState: () => mocks.auth, onAuthStateChange: (changed: (state: { isAuthenticated: boolean }) => void) => {
  mocks.authListeners.add(changed); return () => { mocks.authListeners.delete(changed); };
} }));
vi.mock('../../billing/projection.js', () => ({}));
vi.mock('../../clientEndpointsService.js', () => ({}));
vi.mock('../../deepLink.js', () => ({ openMainWindowRemoteControlSettings: mocks.openRemoteSettings, openMainWindowSession: mocks.openLocalSession }));
vi.mock('../../device-link/providerShareGuest.js', () => ({
  providerShareAccessEpoch: () => mocks.sharedAccessEpoch,
  getReceivedShares: () => [{ shareId: 'share-one', memberId: 'member', providerId: 'anthropic', providerLabel: 'Claude', owner: { displayName: 'Private sharer' }, status: 'active', hostOnline: true, hostCapable: true }],
  onProviderShareReceivedChanged: (callback: () => void) => { mocks.sharedChanged = callback; return () => { mocks.sharedChanged = null; }; },
}));
vi.mock('../../device-link/providerShareRuntime.js', () => ({ readReceivedProviderShareQuota: (...args: unknown[]) => mocks.sharedRead(...args) }));
vi.mock('../../device-link/index.js', () => ({}));
vi.mock('../../device-link/dispatch.js', () => ({ getActiveControllers: () => subscriptions.getControlControllers() }));
vi.mock('../../device-link/ipc.js', () => ({}));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'Fixture' }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en', mainStringKeysUnder: () => [], rawMainString: (key: string) => key }));
vi.mock('../../localDb/ipc/sessions.js', () => ({}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: async () => [] }) }));
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
import { getQuotaOverviewService, QuotaOverviewService, readUsageWidgetSnapshot } from '../../quota-overview/service';
import { beginAppSessionBoundary } from '../../appSessionState';
let overview: QuotaOverviewService;
beforeEach(() => {
  overview = new QuotaOverviewService();
  mocks.app.isPackaged = true;
  vi.useFakeTimers(); mocks.revision = 0; mocks.listeners.clear(); mocks.refresh.mockReset(); mocks.collect.mockReset();
  mocks.sharedRead.mockReset(); mocks.sharedChanged = null; mocks.sharedAccessEpoch = 0;
  mocks.authListeners.clear(); mocks.boundaryPending = false;
  mocks.auth.mode = 'cloud'; mocks.auth.dataOwnerId = 'owner'; mocks.auth.ownerGeneration = 1;
  mocks.activities = []; mocks.attentionListeners.clear(); mocks.publish.mockReset();
  mocks.openOverviewSession.mockReset(); mocks.openLocalSession.mockReset();
  mocks.openRemoteSettings.mockReset(); mocks.onHelperMessage = null;
  subscriptions.__testing.reset();
  mocks.quota = { spend: 2, maxBudget: 10, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Unit: unread updates bypass slow usage collection, survive rebuilds and detach on stop.
it('updates the native count immediately while a usage rebuild is still pending', async () => {
  const service = new MenubarService({ openNewTask() {}, overview });
  const collected = emptyMenubarInputs(Date.now(), 'Fixture');
  mocks.activities = [activity('one'), activity('two')];
  subscriptions.subscribe('phone', ['session:chat']);
  mocks.collect.mockResolvedValue(collected);
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCount: 2, remotelyControlled: true }));
  let resolve!: (value: typeof collected) => void;
  mocks.collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  overview.rebuildSoon();
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
  const service = new MenubarService({ openNewTask() {}, overview });
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
  const service = new MenubarService({ openNewTask() {}, overview });
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
  const service = new MenubarService({ openNewTask() {}, overview });
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
  const service = new MenubarService({ openNewTask() {}, overview });
  const schedule = vi.spyOn(overview as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  service.init();
  expect((await overview['readBalance'](false, Date.now()))?.available).toBe(8);
  schedule.mockClear();
  clearQuota();
  expect(schedule).toHaveBeenCalledWith(0);
  expect(await overview['readBalance'](false, Date.now())).toBeNull();
  service.stop(); expect(mocks.listeners.size).toBe(0);
});
it('rejects the cache even when the clear happened while the menu bar was stopped', async () => {
  const service = new MenubarService({ openNewTask() {}, overview });
  expect((await overview['readBalance'](false, Date.now()))?.available).toBe(8);
  clearQuota();
  expect(await overview['readBalance'](false, Date.now())).toBeNull();
});
it('does not restore the captured cache after an in-flight read fails across clear', async () => {
  const service = new MenubarService({ openNewTask() {}, overview });
  await overview['readBalance'](false, Date.now());
  let reject!: (error: Error) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  const pending = overview['readBalance'](true, Date.now());
  clearQuota(); reject(new Error('unavailable'));
  expect(await pending).toBeNull();
  expect(await overview['readBalance'](false, Date.now())).toBeNull();
});
it('does not publish a view collected before clear', async () => {
  const service = new MenubarService({ openNewTask() {}, overview });
  const schedule = vi.spyOn(overview as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  const publish = vi.spyOn(overview as never, 'publish' as never).mockImplementation(() => undefined);
  service.init();
  let resolve!: (value: unknown) => void;
  mocks.collect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = overview['collectAndPublish'](Date.now(), false, () => {});
  clearQuota(); resolve({}); await pending;
  expect(publish).not.toHaveBeenCalled(); expect(schedule).toHaveBeenCalledWith(0);
  service.stop();
});

it('rebuilds when finite quota arrives after invalidation cached a temporary null', async () => {
  const service = new MenubarService({ openNewTask() {}, overview });
  const schedule = vi.spyOn(overview as never, 'scheduleRebuild' as never).mockImplementation(() => undefined);
  service.init();
  expect((await overview['readBalance'](false, Date.now()))?.available).toBe(8);
  clearQuota();
  expect(await overview['readBalance'](false, Date.now())).toBeNull();
  schedule.mockClear();
  mocks.quota = { spend: 3, maxBudget: 20, currency: 'CNY', fetchedAt: Date.now(), todaySpend: null };
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
  expect(schedule).toHaveBeenCalledWith(0);
  expect((await overview['readBalance'](false, Date.now()))?.available).toBe(17);
  service.stop();
});

// Regression: the widgets only had data while the macOS panel ran, so other platforms and a
// disabled panel answered nothing. A request alone now collects, then stops after its lease.
it('answers a widget request with no panel running and stops collecting when the lease ends', async () => {
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  const pending = readUsageWidgetSnapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toMatchObject({ ok: true, snapshot: { version: 1, sources: [] } });
  expect(mocks.collect).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(getQuotaOverviewService().latest()).toBeNull();
});

// Regression: a build is the account's data; after a switch a phone must get nothing rather than it.
it('never serves a build read for the previous account', async () => {
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  const pending = readUsageWidgetSnapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toMatchObject({ ok: true });
  const old = getQuotaOverviewService().latest();
  expect(old).not.toBeNull();
  mocks.auth.dataOwnerId = 'other';
  try {
    expect(getQuotaOverviewService().latest()).toBeNull();
    const next = getQuotaOverviewService().fresh(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).not.toBe(old);
  } finally {
    mocks.auth.dataOwnerId = 'owner';
  }
});

// Integration of the new reader with the actual panel controller: the panel gets the share,
// while the reusable overview (also consumed by phone widgets) remains owner-only.
it('adds the highest shared weekly quota only to the open native panel and clears it on close', async () => {
  const response = { version: 1, capabilities: { quota: true, usage: false },
    status: { quota: 'ready', usage: 'disabled' }, usage: null,
    quota: { group: true, partial: false, accounts: [{ state: 'ready', updatedAt: Date.now(), balance: null,
      windows: [{ kind: 'week', remainingPercent: 46, resetsAt: Date.now() + 60_000, windowMinutes: 10080, label: null }] }] },
  };
  response.quota.accounts.push({ ...response.quota.accounts[0], windows: [
    { ...response.quota.accounts[0].windows[0], remainingPercent: 82 },
  ] });
  mocks.sharedRead.mockResolvedValue(response);
  mocks.collect.mockResolvedValue(emptyMenubarInputs(Date.now(), 'Fixture'));
  const service = new MenubarService({ openNewTask() {}, overview });
  service.init();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sharedRead).not.toHaveBeenCalled();
  expect(mocks.sharedChanged).toBeNull();
  mocks.onHelperMessage?.({ type: 'panel', open: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish.mock.lastCall?.[0].sources).toContainEqual(expect.objectContaining({ id: 'share:share-one', value: '82' }));
  expect(mocks.publish.mock.lastCall?.[0].details['share:share-one']).toMatchObject({
    plan: 'menubar.shared.highestWeekly', saySecondary: 'menubar.shared.highestWeeklyNote',
  });
  expect(overview.latest()?.input.sources).toEqual([]);
  let finishRefresh!: (value: unknown) => void;
  mocks.sharedRead.mockImplementationOnce(() => new Promise(done => { finishRefresh = done; }));
  const beforeRefresh = mocks.publish.mock.calls.length;
  mocks.onHelperMessage?.({ type: 'refresh' });
  await vi.advanceTimersByTimeAsync(0);
  // The helper resets .detail to .main if any intermediate publication removes this id.
  for (const [view] of mocks.publish.mock.calls.slice(beforeRefresh)) {
    expect(view.details['share:share-one']).toBeDefined();
  }
  finishRefresh(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish.mock.lastCall?.[0].details['share:share-one']).toBeDefined();
  mocks.onHelperMessage?.({ type: 'panel', open: false });
  expect(mocks.sharedChanged).toBeNull();
  expect(mocks.publish.mock.lastCall?.[0].details['share:share-one']).toBeUndefined();
  const closedCalls = mocks.sharedRead.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.sharedRead).toHaveBeenCalledTimes(closedCalls);
  mocks.onHelperMessage?.({ type: 'panel', open: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.publish.mock.lastCall?.[0].details['share:share-one']).toBeDefined();
  mocks.sharedRead.mockRejectedValueOnce(new Error('access denied'));
  mocks.sharedAccessEpoch++;
  mocks.sharedChanged?.();
  expect(mocks.publish.mock.lastCall?.[0].details['share:share-one']).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);
  mocks.onHelperMessage?.({ type: 'panel', open: false });
  expect(mocks.sharedChanged).toBeNull();
  expect(mocks.publish.mock.lastCall?.[0].sources).toEqual([]);
  const calls = mocks.sharedRead.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.sharedRead).toHaveBeenCalledTimes(calls);
  service.stop();
});

// Unit regression for provider-sharing §7.5: the reader cleared memory on auth changes,
// but a null overview suppressed the native update. Hold an old collection unresolved.
it.each(['logout', 'owner', 'boundary', 'session-invalidated'])('clears the presented share immediately on %s while overview is unavailable', async kind => {
  const collected = emptyMenubarInputs(Date.now(), 'Fixture');
  mocks.collect.mockResolvedValue(collected);
  mocks.activities = [activity('private-task')];
  mocks.sharedRead.mockResolvedValue({ version: 1, capabilities: { quota: true, usage: false },
    status: { quota: 'ready', usage: 'disabled' }, usage: null,
    quota: { group: false, partial: false, accounts: [{ state: 'ready', updatedAt: Date.now(), balance: null,
      windows: [{ kind: 'week', remainingPercent: 82, resetsAt: Date.now() + 60_000, windowMinutes: 10080, label: null }] }] },
  });
  const service = new MenubarService({ openNewTask() {}, overview });
  let finishOverview: ((value: typeof collected) => void) | undefined;
  let releaseBoundary: (() => void) | undefined;
  try {
    service.init();
    await vi.advanceTimersByTimeAsync(0);
    mocks.onHelperMessage?.({ type: 'panel', open: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(mocks.publish.mock.lastCall?.[0])).toContain('Private sharer');
    mocks.collect.mockImplementationOnce(() => new Promise(done => { finishOverview = done; }));
    overview.rebuildSoon();
    await vi.advanceTimersByTimeAsync(400);
    expect(finishOverview).toBeDefined();
    if (kind === 'session-invalidated') {
      // Real synchronous boundary signal: no synthetic auth/share notification or owner change.
      const reads = mocks.sharedRead.mock.calls.length;
      releaseBoundary = beginAppSessionBoundary();
      expect(mocks.sharedRead).toHaveBeenCalledTimes(reads);
    } else {
      if (kind === 'boundary') mocks.boundaryPending = true;
      else mocks.auth.dataOwnerId = kind === 'logout' ? null : 'other';
      if (kind === 'logout') mocks.auth.mode = 'signed-out';
      mocks.auth.ownerGeneration++;
      if (kind === 'boundary') mocks.sharedChanged?.();
      else for (const changed of [...mocks.authListeners]) changed({ isAuthenticated: kind !== 'logout' });
    }
    expect(overview.latest()).toBeNull();
    const cleared = mocks.publish.mock.lastCall?.[0];
    expect(cleared.sources).toEqual([]);
    expect(cleared.details).toEqual({});
    expect(cleared.activities ?? []).toEqual([]);
    expect(JSON.stringify(cleared)).not.toContain('Private sharer');
    expect(JSON.stringify(cleared)).not.toContain('private-task');
    expect(cleared.gate).toBe(kind === 'logout' ? 'sign-in' : undefined);
    finishOverview!(collected);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(mocks.publish.mock.lastCall?.[0])).not.toContain('Private sharer');
  } finally {
    finishOverview?.(collected);
    service.stop();
    releaseBoundary?.();
  }
});
