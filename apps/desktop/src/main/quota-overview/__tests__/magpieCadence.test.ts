import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_MENUBAR_SETTINGS, type MenubarHelperMessage } from '../../../shared/menubarQuota';

const mocks = vi.hoisted(() => ({
  auth: { mode: 'cloud', dataOwnerId: 'owner', ownerGeneration: 1, user: { id: 'member', membershipKind: 'org' } },
  revision: 0, listeners: new Set<() => void>(), refresh: vi.fn(),
  quota: null as null | { spend: number; maxBudget: number; currency: string; fetchedAt: number; todaySpend: null },
  readMagpieQuotas: vi.fn(),
  authListeners: new Set<() => void>(),
  providers: [] as unknown[],
}));
vi.mock('electron', () => ({ app: { isPackaged: true }, Notification: class {} }));
vi.mock('../../agent-island/service.js', () => ({ getAgentIslandService: () => ({
  getTaskOverview: () => [], getSessionActivitySnapshots: () => [], subscribeTaskOverview: () => () => {}, subscribeSessionActivity: () => () => {},
}) }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: true, canUseDeviceLink: false }) }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => ({ dataOwnerId: mocks.auth.dataOwnerId, mode: 'cloud', generation: mocks.auth.ownerGeneration }), isAppSessionBoundaryPending: () => false }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => mocks.auth, onAuthStateChange: (listener: (state: typeof mocks.auth) => void) => {
  const notify = () => listener(mocks.auth);
  mocks.authListeners.add(notify);
  return () => mocks.authListeners.delete(notify);
} }));
vi.mock('../../billing/projection.js', () => ({}));
vi.mock('../../clientEndpointsService.js', () => ({}));
vi.mock('../../deepLink.js', () => ({ openMainWindowRemoteControlSettings: vi.fn(), openMainWindowSession: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({}));
vi.mock('../../device-link/dispatch.js', () => ({ getActiveControllers: () => [] }));
vi.mock('../../device-link/ipc.js', () => ({}));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'Fixture' }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en', mainStringKeysUnder: () => [], rawMainString: (key: string) => key }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionRowSnapshot: async () => null }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: async () => mocks.providers }) }));
vi.mock('../../maker-ipc/appDefaultModelControl.js', () => ({}));
vi.mock('../../maker-ipc/register.js', () => ({}));
vi.mock('../../maker-ipc/usage.js', () => ({}));
vi.mock('../../magpie/quotaReader.js', () => ({ readMagpieQuotas: mocks.readMagpieQuotas, MAGPIE_QUOTA_TIMEOUT_MS: 5000, MAGPIE_QUOTA_COLD_READ_TIMEOUT_MS: 15000 }));
vi.mock('../../notificationService.js', () => ({}));
vi.mock('../../serverApiClient.js', () => ({}));
vi.mock('../../usage/claudeAccountUsage.js', () => ({ readClaudeAccountUsageRevision: () => mocks.revision, observeClaudeAccountUsage: (l: () => void) => { mocks.listeners.add(l); return () => { mocks.listeners.delete(l); }; }, triggerClaudeAccountUsageRefresh: () => mocks.refresh(), readClaudeAccountUsageSnapshot: () => mocks.quota }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../usage/usageHistory.js', () => ({ readUsageHistory: async () => ({ todayKey: '2026-11-06', modelDaily: [], tasks: [], taskDaily: [], devices: [] }) }));
vi.mock('../../usageBroadcaster.js', () => ({ observeUsageChanges: () => () => {} }));
vi.mock('../../menubar/settingsStore.js', () => ({ readMenubarSettings: () => ({ ...DEFAULT_MENUBAR_SETTINGS }), writeMenubarSettings: (v: object) => ({ ...DEFAULT_MENUBAR_SETTINGS, ...v }) }));
vi.mock('../../menubar/MacMenubarNativeHost.js', () => ({ MacMenubarNativeHost: class { constructor(_o: { onMessage: (m: MenubarHelperMessage) => void }) {} resetFailure() {} prepare() {} suspend() {} stop() {} publish() {} } }));
vi.mock('../../menubar/creditSamples.js', () => ({ CreditSampleStore: class { record() { return []; } }, estimateDailyBurn: () => null }));

import { QuotaOverviewService } from '../service';

const ORIGIN = 'http://127.0.0.1:3425';
const account = (id: string) => ({
  kind: 'magpie' as const, id: `magpie:magpie:${id}`, providerId: 'magpie-local', provider: 'claude',
  name: 'n', plan: null, windows: [], balanceText: null, status: 'ok' as const, observedAtMs: null, staleAtMs: null,
});

let overview: QuotaOverviewService;
let release: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  mocks.auth.dataOwnerId = 'owner';
  mocks.auth.ownerGeneration = 1;
  mocks.authListeners.clear();
  overview = new QuotaOverviewService();
  mocks.revision = 0; mocks.listeners.clear(); mocks.refresh.mockReset(); mocks.readMagpieQuotas.mockReset();
  mocks.providers = [
    { id: 'magpie-local', name: 'Magpie', source: 'user', connected: true, suspended: false, removed: false, auth: { method: 'apiKey' }, access: { kind: 'api' }, routing: { codex: { upstream: `${ORIGIN}/v1` } } },
  ];
  mocks.readMagpieQuotas.mockResolvedValue({ notMagpie: false, accounts: [account('a')] });
  release = overview.acquire();
});
afterEach(() => { release(); vi.clearAllTimers(); vi.useRealTimers(); });

const flush = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

it('collects each gateway once across connection aliases and retains the same cached source after reordering', async () => {
  const connection = (id: string, upstream: string) => ({
    id, name: id, source: 'user', connected: true, suspended: false, removed: false,
    auth: { method: 'apiKey' }, access: { kind: 'api' }, routing: { codex: { upstream } },
  });
  const first = connection('magpie-a', ORIGIN + '/v1');
  const alias = connection('magpie-b', ORIGIN + '/v1/');
  const different = connection('magpie-c', 'http://127.0.0.1:3426/v1');
  mocks.providers = [alias, different, first];
  mocks.readMagpieQuotas.mockImplementation(async (providerId: string, origin: string) => ({
    notMagpie: false,
    accounts: [{ ...account(origin), id: 'magpie:' + providerId + ':account', providerId }],
  }));
  await flush(0);
  expect(mocks.readMagpieQuotas.mock.calls.map(([providerId, origin]) => [providerId, origin]).sort()).toEqual([
    ['magpie-a', ORIGIN], ['magpie-c', 'http://127.0.0.1:3426'],
  ]);
  const sources = overview.latest()!.input.sources;
  expect(sources.map((source) => source.id).sort()).toEqual(['magpie:magpie-a:account', 'magpie:magpie-c:account']);
  expect(sources.every((source) => source.kind === 'magpie')).toBe(true);
  mocks.providers = [first, different, alias];
  overview.updateSettings({ hidden: ['magpie:magpie-a:account'] });
  await flush(0);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(2);
  expect(overview.latest()!.input.sources.map((source) => source.id).sort()).toEqual(sources.map((source) => source.id).sort());
  expect(overview.latest()!.view.sources.map((source) => source.id)).toEqual(['magpie:magpie-c:account']);
});

it('does not repeatedly probe other loopback gateways while the panel stays open', async () => {
  mocks.readMagpieQuotas.mockResolvedValue({ notMagpie: true, accounts: [] });
  overview.setInteractive(true);
  await flush(1_000);
  await flush(3 * 60_000);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(1);
  expect(overview.latest()?.input.sources.some((source) => source.kind === 'magpie')).toBe(false);
});

it('reads Magpie on the first build after opening the panel, then about every minute while open', async () => {
  await flush(0); // first build while closed
  const closedCalls = mocks.readMagpieQuotas.mock.calls.length;
  expect(closedCalls).toBeGreaterThanOrEqual(1);
  mocks.readMagpieQuotas.mockClear();

  overview.setInteractive(true);
  await flush(0);
  // Opening forces a fresh read even inside the closed TTL.
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(1);

  // While open, the interactive heartbeat (~60s) reaches the open TTL and re-reads.
  await flush(61_000);
  expect(mocks.readMagpieQuotas.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('recovers after an outage: the next good read clears the stale mark', async () => {
  await flush(0);
  overview.setInteractive(true);
  await flush(0);
  mocks.readMagpieQuotas.mockClear();

  // Outage: the failed read keeps the last accounts, marked stale.
  mocks.readMagpieQuotas.mockImplementationOnce(() => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('gateway down')), 8_000);
  }));
  await flush(69_000);
  const stale = overview.latest()?.input.sources.filter((source) => source.kind === 'magpie') ?? [];
  expect(stale[0]?.staleAtMs).not.toBeNull();

  // Recovery: past the retry cooldown a good read clears the mark.
  mocks.readMagpieQuotas.mockResolvedValue({ notMagpie: false, accounts: [account('a')] });
  await flush(61_000);
  const fresh = overview.latest()?.input.sources.filter((source) => source.kind === 'magpie') ?? [];
  expect(fresh[0]).toMatchObject({ id: 'magpie:magpie:a', staleAtMs: null });
});

it('drops to the slow cadence once the panel closes and returns on reopen', async () => {
  await flush(0);
  overview.setInteractive(true);
  await flush(0);
  mocks.readMagpieQuotas.mockClear();

  overview.setInteractive(false);
  // A minute after closing, the closed TTL (10 min) has not elapsed: no new read.
  await flush(61_000);
  expect(mocks.readMagpieQuotas).not.toHaveBeenCalled();

  await flush(240_000);
  expect(mocks.readMagpieQuotas).not.toHaveBeenCalled();
  await flush(300_000);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(1);
  mocks.readMagpieQuotas.mockClear();

  // Reopening forces a read again.
  overview.setInteractive(true);
  await flush(0);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(1);
});

it('starts each open refresh about a minute apart even when quota reads take eight seconds', async () => {
  const start = Date.now();
  const attempts: number[] = [];
  mocks.readMagpieQuotas.mockImplementation(() => {
    attempts.push(Date.now() - start);
    return new Promise((resolve) => setTimeout(() => resolve({ notMagpie: false, accounts: [account('a')] }), 8_000));
  });
  overview.setInteractive(true);
  await flush(8_000);
  expect(overview.latest()?.input.sources).toEqual([expect.objectContaining({ id: 'magpie:magpie:a' })]);
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await flush(60_000);
    expect(attempts).toHaveLength(cycle + 1);
    expect(attempts[cycle] - attempts[cycle - 1]).toBeGreaterThanOrEqual(59_000);
    expect(attempts[cycle] - attempts[cycle - 1]).toBeLessThanOrEqual(61_000);
  }
  await flush(1_000);
  release();
  await flush(120_000);
  expect(attempts).toHaveLength(4);
});

it('coalesces refreshes while a slow read crosses the heartbeat and stops publishing after release', async () => {
  let active = 0;
  let peak = 0;
  mocks.readMagpieQuotas.mockImplementation(() => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise((resolve) => setTimeout(() => {
      active -= 1;
      resolve({ notMagpie: false, accounts: [account('a')] });
    }, 75_000));
  });
  const published = vi.fn();
  overview.subscribe(published);
  overview.setInteractive(true);
  await flush(61_000);
  overview.refresh(true);
  overview.refresh(true);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(1);
  await flush(15_000);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(2);
  expect(peak).toBe(1);
  expect(published).toHaveBeenCalledTimes(1);
  release();
  await flush(150_000);
  expect(published).toHaveBeenCalledTimes(1);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(2);
});

it('discards an in-flight result after switching owners and returning to the original owner', async () => {
  mocks.readMagpieQuotas.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => {
    resolve({ notMagpie: false, accounts: [account('old')] });
  }, 8_000))).mockResolvedValue({ notMagpie: false, accounts: [account('current')] });
  await flush(1_000);
  mocks.auth.dataOwnerId = 'other';
  mocks.auth.ownerGeneration += 1;
  mocks.authListeners.forEach((notify) => notify());
  expect(overview.latest()).toBeNull();
  mocks.auth.dataOwnerId = 'owner';
  mocks.auth.ownerGeneration += 1;
  mocks.authListeners.forEach((notify) => notify());
  await flush(8_000);
  expect(mocks.readMagpieQuotas).toHaveBeenCalledTimes(2);
  expect(overview.latest()?.input.sources).toEqual([expect.objectContaining({ id: 'magpie:magpie:current' })]);
});
