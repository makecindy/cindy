const standby = vi.hoisted(() => ({ publish: vi.fn(), refresh: vi.fn(), flush: vi.fn(), usage: vi.fn() }));
vi.mock('../providerShareAvailability.js', () => ({ publishShareAvailability: standby.publish, refreshStandbyGuests: standby.refresh }));
vi.mock('../providerShareAvailabilityUsage.js', () => ({ flushStandbyUsage: standby.flush, importStandbyUsage: standby.usage }));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, type BrowserWindow } from 'electron';
import { PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, REMOTE_AGENT_CHANNEL, type InvokeResultPayload,
  type ProviderShareOwned, type ProviderShareReceived } from '@cindy/device-link';

import type { ProviderShareManagementCommand } from '../../../shared/providerManagement';
import type { ProviderUsageHistoryView } from '../../../shared/providerShare';
import type { ModelPriceQuote } from '../../../shared/regionalMoney';

const state = vi.hoisted(() => ({ owner: 'owner-a', boundaryPending: false }));
const windowRouting = vi.hoisted(() => ({
  windows: [] as BrowserWindow[], focusMain: vi.fn(), notifications: [] as EventEmitter[],
}));
vi.mock('../../deepLink.js', () => ({ focusMainWindow: windowRouting.focusMain }));
vi.mock('../../notificationService.js', () => ({ getDesktopNotificationsEnabled: () => true }));
const received = vi.hoisted(() => ({ shares: [] as ProviderShareReceived[], ready: true }));
vi.mock('electron', () => ({
  app: { getPath: () => 'test-provider-share-user-data' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => windowRouting.windows },
  Notification: class extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); windowRouting.notifications.push(this); }
    show() { this.emit('show'); }
  },
}));
const api = vi.hoisted(() => ({ createLink: vi.fn(), approve: vi.fn(), reject: vi.fn(), setMember: vi.fn() }));
const host = vi.hoisted(() => ({
  refresh: vi.fn(), snapshot: vi.fn(), quiet: vi.fn(), active: vi.fn(), decision: vi.fn(), member: vi.fn(),
}));
const listProviders = vi.hoisted(() => vi.fn());
const identityCard = vi.hoisted(() => vi.fn());
const remember = vi.hoisted(() => vi.fn());
const usageStores = vi.hoisted(() => ({ ownHistory: vi.fn(), memberTokenSnapshot: vi.fn(), memberHistory: vi.fn(), pricing: vi.fn(), referencePricing: vi.fn(), priceOverrides: vi.fn(),
  enqueueDirectCleanup: vi.fn(), listPendingDirectCleanup: vi.fn(), acknowledgeDirectCleanup: vi.fn(),
  actual: null as ReturnType<typeof import('../providerShareUsageStore').createProviderShareUsageStore> | null }));
const memberNotes = vi.hoisted(() => ({ read: vi.fn(), set: vi.fn() }));
vi.mock('../providerShareQuota.js', () => ({ readProviderShareQuota: vi.fn(), readProviderShareQuotaAccount: vi.fn() }));
const visibility = vi.hoisted(() => ({ read: vi.fn(), set: vi.fn() }));
const modelAccess = vi.hoisted(() => ({ subscribe: () => () => undefined, read: vi.fn(), set: vi.fn(), allows: vi.fn() }));
const fastPolicy = vi.hoisted(() => ({ allows: vi.fn(), set: vi.fn(), changed: vi.fn(), publish: vi.fn() }));
const localBroadcast = vi.hoisted(() => vi.fn());
vi.mock('../index.js', () => ({ broadcast: localBroadcast }));
vi.mock('../../maker-host/provider-fast-policy-store.js', () => ({ providerFastPolicy: fastPolicy }));
vi.mock('../../maker-host/subscription-fast-policy.js', () => ({ notifySubscriptionFastPolicyChanged: fastPolicy.changed }));
vi.mock('../remoteModelAccess.js', () => ({ remoteModelAccess: modelAccess }));
vi.mock('../providerShareVisibility.js', () => ({ providerShareVisibility: visibility }));
vi.mock('../providerShareMemberNotes.js', () => ({ providerShareMemberNotes: memberNotes }));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.boundaryPending,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: state.owner, ownerGeneration: 1 }),
}));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => 'host-device' }));
vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders }),
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true, onRemoteProviderAccessChanged: () => () => undefined }));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: remember }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../usage/modelPricing.js', async () => ({
  getGatewayModelPricing: usageStores.pricing,
  getModelPriceQuote: (await import('../../../shared/modelPriceQuote.js')).getModelPriceQuote,
}));
vi.mock('../../usage/referenceModelPricing.js', () => ({
  getReferenceModelPricing: usageStores.referencePricing,
  readModelPriceOverridesSnapshot: usageStores.priceOverrides,
}));
vi.mock('../../usage/providerPartyUsageStore.js', () => ({
  currentProviderPartyUsageStore: () => ({ history: usageStores.ownHistory }),
}));
vi.mock('../providerShareUsageStore.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providerShareUsageStore.js')>(),
  getProviderShareUsageStore: () => usageStores.actual ?? ({ history: usageStores.memberHistory, memberTokenSnapshot: usageStores.memberTokenSnapshot,
    enqueueDirectCleanup: usageStores.enqueueDirectCleanup,
    listPendingDirectCleanup: usageStores.listPendingDirectCleanup,
    acknowledgeDirectCleanup: usageStores.acknowledgeDirectCleanup }),
  providerUsageLocalDay: () => '2026-10-17',
}));
vi.mock('../settings-store.desktop.js', () => ({ onDeviceLinkSettingChanged: () => () => undefined, readDeviceLinkSettings: () => ({ remoteControlEnabled: true }), readLastKnownDeviceNames: () => ({}) }));
vi.mock('../providerShareApi.js', () => ({
  providerShareApi: api,
  fetchIdentityCard: identityCard,
  sha256Hex: (value: string) => value,
  providerShareLinkFor: () => 'https://cindy.app/s#test-link',
  providerShareOwnerKey: () => state.owner,
}));
vi.mock('../dispatch.desktop.js', () => ({
  notifyProviderShareCatalogChanged: fastPolicy.publish,
  getControllerDisplayName: vi.fn(), providerShareActiveControllers: vi.fn(),
  revalidateRemoteModelAccess: vi.fn(async () => undefined), revokeProviderShareControllers: vi.fn(async () => undefined), setProviderShareAccess: vi.fn(),
}));
vi.mock('../providerShareReshare.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providerShareReshare.js')>(),
  pruneProviderShareReshares: vi.fn(async () => undefined),
}));
vi.mock('../providerShareHost.js', () => ({
  startProviderShareHost: vi.fn(), stopProviderShareHost: vi.fn(),
  getProviderShareHostLoadedSnapshot: () => null, onProviderShareHostChanged: () => () => {},
  refreshProviderShareHost: host.refresh, getProviderShareHostSnapshot: host.snapshot,
  clearProviderShareRequestQuiet: vi.fn(),
  providerShareAccessRevision: vi.fn(), providerShareGuestAccess: vi.fn(), ownedProviderShareGuestAccess: vi.fn(),
  providerShareGuestDenial: vi.fn(), ensureProviderSharePeerKnown: vi.fn(),
  quietProviderShareRequests: host.quiet, markProviderShareHostActive: host.active,
  applyLocalRequestDecision: host.decision, applyLocalMemberChange: host.member,
  providerShareMemberMatcher: (member: { shareId: string; memberId: string }) => (controller: string) => {
    try {
      const parts = JSON.parse(controller.replace(/~+$/, '')) as unknown;
      return Array.isArray(parts) && parts[0] === 'provider-share' && parts[1] === member.shareId
        && parts[2] === 'guest' && parts[3] === member.memberId;
    } catch { return false; }
  },
}));
const guest = vi.hoisted(() => ({ revision: 0, share: null as unknown }));
vi.mock('../providerShareGuest.js', () => ({ startProviderShareGuest: vi.fn(), stopProviderShareGuest: vi.fn(), findReceivedShare: () => guest.share, providerShareAccessEpoch: () => guest.revision,
  getReceivedSharesSnapshot: () => ({ received: received.shares }), isReceivedSharesReady: () => received.ready }));
vi.mock('../providerShareGuestPrefs.js', () => ({ configureProviderShareGuestPrefs: vi.fn(), invalidateProviderShareGuestPrefsCache: vi.fn() }));
vi.mock('../providerShareGuestPrefsIpc.js', () => ({ setProviderShareCredentialConsentFromIpc: vi.fn() }));

import {
  openProviderShareJoin,
  executeProviderShareManagementCommand,
  parseProviderShareCommand,
  registerProviderShareIpc,
  startProviderShareRuntime,
  stopProviderShareRuntime,
  trimProviderUsageHistory,
} from '../providerShareRuntime';
import { markAppContentWindow } from '../../windowFocusClassifier';
import { startProviderShareHost } from '../providerShareHost';
import { startProviderShareGuest } from '../providerShareGuest';
import { setBroadcastTapListener } from '../broadcast-tap';
import { CONTROLLED_MODEL_CATALOG_CHANGED } from '../../../shared/controlledModelCatalog';
import { PROVIDER_SHARE_IPC } from '../../../shared/providerShare';
import { createProviderShareUsageStore } from '../providerShareUsageStore';
import { revokeProviderShareControllers } from '../dispatch.desktop';
import {
  clearAllProviderShareCatalogs,
  getCachedProviderShareCatalogs,
  refreshProviderShareCatalogs,
} from '../../../../../mobile/src/device-link/providerShareCatalogCache';

const createLink: ProviderShareManagementCommand = { action: 'create-link', providerId: 'anthropic' };
const LINK_ID = 'a'.repeat(64);
const mutations: ProviderShareManagementCommand[] = [
  { action: 'approve', requestId: 'r1' },
  { action: 'reject', requestId: 'r1' },
  { action: 'set-member', memberId: 'm1', status: 'remove' },
];

function saveMemberNote(entry: 'local' | 'same-account'): Promise<unknown> {
  const command = { action: 'set-member-note', memberId: 'm1', note: 'Alice' } as const;
  if (entry === 'same-account') return executeProviderShareManagementCommand(command);
  const handle = vi.spyOn(ipcMain, 'handle');
  try {
    registerProviderShareIpc();
    const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
    return handler({} as Electron.IpcMainInvokeEvent, command);
  } finally {
    handle.mockRestore();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  windowRouting.windows = [];
  windowRouting.notifications = [];
  windowRouting.focusMain.mockReturnValue(true);
  state.owner = 'owner-a';
  state.boundaryPending = false;
  usageStores.actual = null;
  listProviders.mockResolvedValue([{ id: 'anthropic', name: 'Anthropic', connected: true, agents: ['claude-code'] }]);
  received.shares = [];
  received.ready = true;
  clearAllProviderShareCatalogs();
  identityCard.mockResolvedValue({ card: 'test-identity-card' });
  api.createLink.mockResolvedValue({ invitation: 'test-invitation', linkId: LINK_ID });
  api.approve.mockResolvedValue({ ok: true });
  api.reject.mockResolvedValue({ ok: true });
  api.setMember.mockResolvedValue({ status: 'removed' });
  host.refresh.mockResolvedValue(undefined);
  memberNotes.read.mockReturnValue({});
  memberNotes.set.mockResolvedValue(undefined);
  modelAccess.read.mockReturnValue({ models: null, providerModels: null });
  modelAccess.set.mockImplementation(async (_provider, _models, _member, assertCurrent) => { assertCurrent(); });
  fastPolicy.allows.mockReturnValue(true);
  fastPolicy.set.mockImplementation(async (_provider, allowed, assertCurrent) => { assertCurrent(); fastPolicy.allows.mockReturnValue(allowed); });
  fastPolicy.changed.mockResolvedValue(undefined);
  host.snapshot.mockReturnValue([{ requests: [{ requestId: 'r1' }], members: [{ memberId: 'm1' }] }]);
  usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: [] }, relays: [] });
  usageStores.memberHistory.mockReturnValue([]);
  usageStores.memberTokenSnapshot.mockReturnValue({ available: true, models: [],
    windowStart: '2026-10-11', windowEnd: '2026-10-17', nextWindowAt: new Date(2026, 9, 18).getTime() });
  usageStores.enqueueDirectCleanup.mockResolvedValue(undefined);
  usageStores.listPendingDirectCleanup.mockReturnValue([]);
  usageStores.acknowledgeDirectCleanup.mockResolvedValue(undefined);
  usageStores.pricing.mockResolvedValue(null);
  usageStores.referencePricing.mockReturnValue({});
  usageStores.priceOverrides.mockReturnValue({});
  startProviderShareRuntime(vi.fn());
});

afterEach(() => { setBroadcastTapListener(null); stopProviderShareRuntime(); });

// #9437 / unit: real share entry points must not show the first hidden data host.
// Earlier management coverage always returned no BrowserWindows. The shared
// deepLink suite separately verifies restoration/focus of the registered main window.
function backgroundWindow(focused = false): BrowserWindow {
  return {
    isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
    isFocused: () => focused, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), setAlwaysOnTop: vi.fn(),
  } as unknown as BrowserWindow;
}

it.each([true, false])('routes invitation activation to main without touching a helper (main available: %s)', (available) => {
  const helper = backgroundWindow();
  windowRouting.windows = [helper];
  windowRouting.focusMain.mockReturnValue(available);
  openProviderShareJoin('cindy://provider-share/join?test=synthetic');
  expect(helper.show).not.toHaveBeenCalled();
  expect(helper.focus).not.toHaveBeenCalled();
  expect(windowRouting.focusMain).toHaveBeenCalledOnce();
});

it.each(['background', 'helper-focused', 'app-focused'] as const)(
  'keeps receipt passive and only notification activation focuses main (%s)', async (foreground) => {
    const helper = backgroundWindow(foreground === 'helper-focused');
    const main = backgroundWindow(foreground === 'app-focused');
    markAppContentWindow(main);
    windowRouting.windows = [helper, main];
    const callbacks = vi.mocked(startProviderShareHost).mock.calls.at(-1)![0];
    callbacks.requested({
      requestId: 'synthetic', displayName: 'Test', avatarUrl: null, region: 'global', pairingCode: '4827',
      createdAt: '2026-11-09T00:00:00Z', expiresAt: '2026-11-10T00:00:00Z',
    }, { shareId: 'synthetic', hostDeviceId: 'host-device', providerId: 'test', providerLabel: 'Test', createdAt: '', members: [], requests: [] }, false);
    expect(windowRouting.focusMain).not.toHaveBeenCalled();
    if (foreground === 'app-focused') {
      expect(windowRouting.notifications).toHaveLength(0);
    } else {
      await vi.waitFor(() => expect(windowRouting.notifications).toHaveLength(1));
      windowRouting.notifications[0].emit('click');
      expect(windowRouting.focusMain).toHaveBeenCalledOnce();
    }
    expect(helper.show).not.toHaveBeenCalled();
    expect(helper.focus).not.toHaveBeenCalled();
  },
);

// #8010 review / unit: real runtime callbacks must reach the device-link tap,
// not just local windows. Existing management tests only observed local delivery.
it.each(['catalog', 'received', 'stop'] as const)('forwards %s invalidation to remote catalog viewers', trigger => {
  const local = vi.fn();
  const remote = vi.fn();
  startProviderShareRuntime(local);
  setBroadcastTapListener(remote);
  const events = vi.mocked(startProviderShareGuest).mock.lastCall![0];
  if (trigger === 'catalog') events.catalogChanged!('share:b-only');
  else if (trigger === 'received') events.changed([], true);
  else stopProviderShareRuntime();
  expect(local).toHaveBeenCalledWith(CONTROLLED_MODEL_CATALOG_CHANGED, {});
  expect(remote).toHaveBeenCalledWith(CONTROLLED_MODEL_CATALOG_CHANGED, {},
    { dataOwnerId: 'owner-a', ownerGeneration: 1 });
});

// 2026-11-04 (PR #8814): the received list is polled every minute. An unchanged poll
// still refreshes local windows (stale subscription catalogs are re-checked there) but
// must not push a model catalog change to every controlling computer.
it('refreshes local windows but does not push a catalog change for an unchanged received poll', () => {
  const local = vi.fn();
  const remote = vi.fn();
  startProviderShareRuntime(local);
  setBroadcastTapListener(remote);
  const events = vi.mocked(startProviderShareGuest).mock.lastCall![0];
  events.changed([], false);
  expect(local).toHaveBeenCalledWith(PROVIDER_SHARE_IPC.RECEIVED_CHANGED, []);
  expect(local).not.toHaveBeenCalledWith(CONTROLLED_MODEL_CATALOG_CHANGED, {});
  expect(remote).not.toHaveBeenCalledWith(CONTROLLED_MODEL_CATALOG_CHANGED, {}, expect.anything());
});

/* Unit integration: the real received-catalogs producer must distinguish an explicit
 * per-share provider refusal from a temporary/offline null, and the real Mobile parser/cache
 * must retire only that share. */
it('propagates a per-share provider denial as an empty zero-budget catalog and keeps transient neighbors', async () => {
  const provider = (id = 'anthropic') => ({
    id, name: 'Anthropic', source: 'builtin', agents: ['claude-code'], auth: { method: 'none' },
    routing: { 'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' } },
    models: { 'claude-code': [] }, connected: true,
  });
  const receivedShare = (id: string): ProviderShareReceived => ({
    shareId: id, memberId: 'm-' + id, providerId: 'anthropic', providerLabel: 'Anthropic',
    hostDeviceId: 'host-' + id, deviceName: 'Device ' + id,
    owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
    status: 'active', hostOnline: true, hostCapable: true,
  });
  const mobileShare = (id: string, catalog: unknown) => ({
    agentDeviceId: 'share:' + id, shareId: id, providerId: 'anthropic', providerLabel: 'Anthropic',
    deviceName: 'Device ' + id, owner: { displayName: 'Owner', avatarUrl: null },
    status: 'active', hostOnline: true, catalog,
  });
  received.shares = [receivedShare('a'), receivedShare('b'), receivedShare('c'), receivedShare('d'), receivedShare('e')];
  const invoke = vi.fn(async (agentDeviceId: string): Promise<InvokeResultPayload> => {
    if (agentDeviceId === 'share:a') {
      return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'denied' } };
    }
    if (agentDeviceId === 'share:b') return { ok: true, result: { providers: [provider()] } };
    if (agentDeviceId === 'share:d') throw Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' });
    if (agentDeviceId === 'share:e') {
      throw Object.assign(new Error('disabled'), { code: 'PROVIDER_SHARE_CROSS_REGION_DISABLED' });
    }
    return { ok: false, error: { code: 'INVOKE_TIMEOUT', message: 'timeout' } };
  });
  stopProviderShareRuntime();
  startProviderShareRuntime(vi.fn(), { invoke });
  registerProviderShareIpc();
  const handler = vi.mocked(ipcMain.handle).mock.calls
    .find(([channel]) => channel === PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL)![1];
  const producerResult = await handler({} as Electron.IpcMainInvokeEvent,
    [{ capabilities: ['provider-logo-kinds-v2'] }]) as { ready: boolean; shares: Array<{
      agentDeviceId: string; shareId: string; catalog: unknown }> };
  const producerById = new Map(producerResult.shares.map(share => [share.shareId, share]));
  expect(producerById.get('a')?.catalog).toEqual({ providers: [],
    providerContinuity: { stale: true, remainingMs: 0 } });
  expect((producerById.get('b')?.catalog as { providers?: unknown[] } | null)?.providers).toHaveLength(1);
  expect(producerById.get('b')).toMatchObject({
    favoriteSource: { shareId: 'b', memberId: 'm-b', providerId: 'anthropic', owner: { region: 'global' } },
  });
  expect(producerById.get('c')?.catalog).toBeNull();
  expect(producerById.get('d')?.catalog).toEqual({ providers: [],
    providerContinuity: { stale: true, remainingMs: 0 } });
  // A region feature flag is not a per-share revocation.
  expect(producerById.get('e')?.catalog).toBeNull();

  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  try {
    const seededCatalog = { providers: [provider()],
      providerContinuity: { stale: false, remainingMs: 10_000 } };
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [
      mobileShare('a', seededCatalog), mobileShare('b', seededCatalog), mobileShare('c', seededCatalog),
      mobileShare('d', seededCatalog), mobileShare('e', seededCatalog),
    ] }));
    expect(getCachedProviderShareCatalogs('host')?.filter(entry => entry.payload))
      .toHaveLength(5);

    await vi.advanceTimersByTimeAsync(500);
    await refreshProviderShareCatalogs('host', async () => producerResult);
    const after = new Map((getCachedProviderShareCatalogs('host') ?? []).map(entry => [entry.shareId, entry]));
    expect(after.get('a')?.payload).toBeNull();
    expect(after.get('b')?.payload?.providers).toHaveLength(1);
    expect(after.get('c')?.payload?.providers).toHaveLength(1);
    expect(after.get('d')?.payload).toBeNull();
    expect(after.get('e')?.payload?.providers).toHaveLength(1);

    // C was never renewed by the transient null: its original 10s budget expires.
    await vi.advanceTimersByTimeAsync(9_501);
    const expired = new Map((getCachedProviderShareCatalogs('host') ?? []).map(entry => [entry.shareId, entry]));
    expect(expired.get('c')?.payload).toBeNull();
    expect(expired.get('e')?.payload).toBeNull();

    // A fresh authoritative read restores A without touching B/C.
    const freshA = { ...producerById.get('a')!, catalog: { providers: [provider()] } };
    await refreshProviderShareCatalogs('host', async () => ({ ...producerResult,
      shares: [freshA, producerById.get('b')!, producerById.get('c')!, producerById.get('d')!, producerById.get('e')!] }));
    const recovered = new Map((getCachedProviderShareCatalogs('host') ?? []).map(entry => [entry.shareId, entry]));
    expect(recovered.get('a')?.payload?.providers).toHaveLength(1);
    expect(recovered.get('b')?.payload?.providers).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    clearAllProviderShareCatalogs();
  }
});

/* Deleting a member must use the live host callback and retain offline M until it ACKs. tier: unit. */
describe('direct guest deletion delivery', () => {
  // Unit tier: production runtime callbacks + real durable ledger; only transport
  // and local host are controlled. O misses remove/reapprove while stopped.
  it('blocks a reapproved member until local purge and the old M forget complete after restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-rejoin-'));
    try {
      stopProviderShareRuntime();
      const file = path.join(dir, 'usage.json');
      let store = usageStores.actual = createProviderShareUsageStore(file);
      const route = { ownerScope: 'owner-a', ownerDeviceId: 'host-device', shareId: 'share-1', memberId: 'm1',
        memberJoinedAt: 'g1', guestDeviceId: 'G', sessionId: 'old-task', executorDeviceId: 'M',
        executorProviderId: 'local', agentKind: 'codex', providerId: 'p', memberKey: 'M', model: 'gpt',
        generation: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 30 * 60_000 };
      const snapshot = (joinedAt: string, status: 'active' | 'paused' = 'active'): ProviderShareOwned[] => [{
        shareId: route.shareId, providerId: 'p', providerLabel: 'P', hostDeviceId: 'host-device', createdAt: 'x', requests: [],
        members: [{ memberId: 'm1', joinedAt, status, displayName: 'Guest', avatarUrl: null, region: 'global' }],
      }];
      startProviderShareRuntime(vi.fn());
      let callbacks = vi.mocked(startProviderShareHost).mock.lastCall![0];
      await callbacks.prepareSnapshot!(snapshot('g1'));
      await store.registerDirectReceiptRoute(route);
      await store.commitDirectReceiptRoute(route);
      await callbacks.prepareSnapshot!(snapshot('g1', 'paused'));
      await callbacks.prepareSnapshot!(snapshot('g1'));
      expect(revokeProviderShareControllers).not.toHaveBeenCalled();
      expect(store.findDirectTaskLocation(route)?.executorDeviceId).toBe('M');
      stopProviderShareRuntime();
      store = usageStores.actual = createProviderShareUsageStore(file);
      let acknowledge!: (result: { ok: true; result: object }) => void;
      const invoke = vi.fn(() => new Promise<{ ok: true; result: object }>((resolve) => { acknowledge = resolve; }));
      startProviderShareRuntime(vi.fn(), { invoke });
      callbacks = vi.mocked(startProviderShareHost).mock.lastCall![0];
      await callbacks.prepareSnapshot!(snapshot('g2'));
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(store.findDirectTaskLocation(route)).toBeNull();
      expect(callbacks.memberReady!({ shareId: route.shareId, memberId: 'm1', joinedAt: 'g2' })).toBe(false);
      const renewed = { ...route, memberJoinedAt: 'g2', generation: '22222222-2222-4222-8222-222222222222' };
      await expect(store.registerDirectReceiptRoute(renewed)).rejects.toThrow('cleanup is pending');
      // A missing host handler returning successfully is not proof of local cleanup.
      expect(store.listPendingMemberCleanup('owner-a', 'host-device')).toHaveLength(1);
      await store.acknowledgeMemberCleanup(store.listPendingMemberCleanup('owner-a', 'host-device')[0]!);
      expect(callbacks.memberReady!({ shareId: route.shareId, memberId: 'm1', joinedAt: 'g2' })).toBe(false);
      expect(invoke).toHaveBeenCalledWith('M', REMOTE_AGENT_CHANNEL, [expect.objectContaining({
        op: 'forget', directGuest: expect.objectContaining({ shareId: 'share-1', memberId: 'm1', guestDeviceId: 'G' }),
      })], expect.any(Object));
      acknowledge({ ok: true, result: {} });
      await vi.waitFor(() => expect(callbacks.memberReady!({ shareId: route.shareId, memberId: 'm1', joinedAt: 'g2' })).toBe(true));
      expect(store.findDirectTaskLocation(route)).toBeNull();
      await store.registerDirectReceiptRoute(renewed);
    } finally {
      stopProviderShareRuntime();
      usageStores.actual = null;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a scoped, retryable forget to the recorded executor', async () => {
    const target = { ownerScope: 'owner-a', shareId: 'share-1', memberId: 'm1',
      guestDeviceId: 'guest-pc', executorDeviceId: 'executor-pc',
      pendingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cleanupEpoch: 1 };
    usageStores.listPendingDirectCleanup.mockReturnValue([target]);
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'DEVICE_OFFLINE' } })
      .mockResolvedValue({ ok: true, result: {} });
    stopProviderShareRuntime();
    startProviderShareRuntime(vi.fn(), { invoke });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(usageStores.acknowledgeDirectCleanup).not.toHaveBeenCalled();

    const callbacks = vi.mocked(startProviderShareHost).mock.lastCall![0];
    callbacks.revoked({ shareId: target.shareId, memberId: target.memberId }, true);
    await vi.waitFor(() => expect(usageStores.enqueueDirectCleanup).toHaveBeenCalledWith(
      'owner-a', expect.any(Function)));
    const matcher = usageStores.enqueueDirectCleanup.mock.lastCall![1];
    expect(matcher(target)).toBe(true);
    expect(matcher({ ...target, memberId: 'another' })).toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('executor-pc', REMOTE_AGENT_CHANNEL, [{
      op: 'forget', directGuest: { shareId: 'share-1', memberId: 'm1', guestDeviceId: 'guest-pc',
        forgetId: target.pendingId, cleanupEpoch: 1 },
    }], expect.objectContaining({ preSend: expect.any(Function) }));
    await vi.waitFor(() => expect(usageStores.acknowledgeDirectCleanup).toHaveBeenCalledWith(target));
  });
});

const historyRow = (index: number, model = 'model-' + index): ProviderUsageHistoryView['self']['days'][number] => ({
  day: '2026-10-17',
  kind: 'claude-code',
  providerId: 'anthropic',
  memberKey: 'local',
  model,
  turns: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: null,
});

const historyWithRows = (rows: ProviderUsageHistoryView['self']['days']): ProviderUsageHistoryView => ({
  providerId: 'anthropic',
  todayKey: '2026-10-17',
  coverageStart: null,
  self: { lastUsedAt: null, days: rows },
  relays: [],
  members: [],
});

// Unit regression: usage-history must return estimates for self, relay and shared
// usage with no SDK cost. Existing wire-budget tests only covered SDK fallback
// and mocked out quote lookup/calculation, hiding the missing reference-price source.
describe('provider share usage estimates', () => {
  const quote: ModelPriceQuote = {
    providerId: 'openai', modelId: 'gpt-6.1-sol', currency: 'USD',
    source: 'provider-reference', approximate: true,
    inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.2,
  };
  const row = () => ({
    ...historyRow(0, 'gpt-6.1-sol [high]'), providerId: 'openai', kind: 'codex',
    inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 2_000, sdkCostUsd: 0,
  });

  async function readEstimate(providerId = 'openai', sdkCostUsd = 0) {
    usageStores.ownHistory.mockReturnValue({
      self: { lastUsedAt: null, days: [{ ...row(), providerId, sdkCostUsd }] }, relays: [],
    });
    const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId }) as ProviderUsageHistoryView;
    return result.self.days[0]?.amount;
  }

  it('prices OpenAI self, relay and member usage from engine-specific reference quotes', async () => {
    usageStores.pricing.mockResolvedValue({ xd: { 'gpt-6.1-sol': { ...quote, providerId: 'xd', inputPerMtok: 999 } } });
    usageStores.referencePricing.mockReturnValue({ openai: {
      'gpt-6.1-sol': { ...quote, inputPerMtok: 999 },
      'gpt-6.1-sol\u0000codex': quote,
    } });
    usageStores.ownHistory.mockReturnValue({
      self: { lastUsedAt: null, days: [row()] },
      relays: [{ deviceId: 'relay', lastUsedAt: null, days: [row()] }],
    });
    host.snapshot.mockReturnValue([{ providerId: 'openai', shareId: 's', members: [{ memberId: 'm1' }] }]);
    usageStores.memberHistory.mockReturnValue([{ shareId: 's', memberId: 'm1', lastUsedAt: null, days: [row()] }]);
    const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'openai' }) as ProviderUsageHistoryView;
    for (const usage of [result.self, result.relays[0]!, result.members[0]!]) {
      expect(usage.days[0]?.amount?.amount).toBeCloseTo(0.0034, 8);
      expect(usage.days[0]?.amount?.currency).toBe('USD');
    }
  });

  it('keeps Cindy AI on Gateway prices and applies its discount once', async () => {
    usageStores.pricing.mockResolvedValue({ xd: { 'gpt-6.1-sol': {
      ...quote, providerId: 'xd', source: 'gateway', costDiscount: 0.5,
    } } });
    usageStores.referencePricing.mockReturnValue({ xd: { 'gpt-6.1-sol': { ...quote, inputPerMtok: 999 } } });
    expect(await readEstimate('xd')).toEqual({ amount: 0.0017, currency: 'USD' });
  });

  it('refreshes the reference snapshot on the next query after a price change', async () => {
    usageStores.referencePricing.mockReturnValue({ openai: { 'gpt-6.1-sol': quote } });
    expect((await readEstimate())?.amount).toBeCloseTo(0.0034, 8);
    usageStores.referencePricing.mockReturnValue({ openai: { 'gpt-6.1-sol': { ...quote, inputPerMtok: 4 } } });
    expect((await readEstimate())?.amount).toBeCloseTo(0.0054, 8);
  });

  it.each([
    { sdkCostUsd: 0, expected: null },
    { sdkCostUsd: 0.25, expected: { amount: 0.25, currency: 'USD' } },
  ])('retains SDK fallback or unknown when no quote exists ($sdkCostUsd)', async ({ sdkCostUsd, expected }) => {
    expect(await readEstimate('openai', sdkCostUsd)).toEqual(expected);
  });

  it('falls back to SDK cost when reference pricing cannot be read', async () => {
    usageStores.referencePricing.mockImplementation(() => { throw new Error('pricing unavailable'); });
    expect(await readEstimate('deepseek', 0.25)).toEqual({ amount: 0.25, currency: 'USD' });
  });

  // PR #8489 review: aggregate buckets must not pick a long-context band from the
  // summed input of many short turns. Minimal input: one band boundary at 272,001.
  it('selects input price bands per average turn instead of the aggregate total', async () => {
    usageStores.referencePricing.mockReturnValue({ openai: { 'gpt-6.1-sol': {
      ...quote,
      inputTokenPriceBands: [
        { minInputTokens: 0, maxInputTokens: 272_001, inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.2 },
        { minInputTokens: 272_001, inputPerMtok: 4, outputPerMtok: 15, cacheReadPerMtok: 0.4 },
      ],
    } } });
    const read = async (turns: number) => {
      usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: [{
        ...row(), turns, inputTokens: 300_000, outputTokens: 1_000, cacheReadTokens: 0,
      }] }, relays: [] });
      const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'openai' }) as ProviderUsageHistoryView;
      return result.self.days[0]?.amount?.amount;
    };
    // 10 turns × 30k input stay on the base band: 300k × $2 + 1k × $10.
    expect(await read(10)).toBeCloseTo(0.61, 8);
    // A single 300k turn is genuinely long-context: 300k × $4 + 1k × $15.
    expect(await read(1)).toBeCloseTo(1.215, 8);
  });

  // PR #8489 review: history rows are valued with the catalog effective on their own day,
  // using the same route-tariff rules as the range totals rather than subscription values.
  it('prices history rows from the reference catalog effective on that day', async () => {
    const overrides = { snapshot: true };
    usageStores.priceOverrides.mockReturnValue(overrides);
    usageStores.referencePricing.mockImplementation((options?: { at?: string }) =>
      options?.at === '2026-10-17' ? { openai: { 'gpt-6.1-sol': { ...quote, inputPerMtok: 4 } } } : { openai: { 'gpt-6.1-sol': quote } });
    expect((await readEstimate())?.amount).toBeCloseTo(0.0054, 8);
    expect(usageStores.referencePricing).toHaveBeenCalledWith({ at: '2026-10-17', overrides });
  });

  it('resolves a tariff that is no longer effective today', async () => {
    usageStores.referencePricing.mockImplementation((options?: { at?: string }) =>
      options?.at === '2026-10-17' ? { openai: { 'gpt-6.1-sol': quote } } : {});
    expect((await readEstimate())?.amount).toBeCloseTo(0.0034, 8);
  });

  it('does not borrow today\'s price for a day without an effective tariff', async () => {
    usageStores.referencePricing.mockImplementation((options?: { at?: string }) =>
      options?.at === undefined ? { openai: { 'gpt-6.1-sol': quote } } : {});
    expect(await readEstimate()).toBeNull();
  });

  it('builds one reference catalog per day and reads overrides once per query', async () => {
    usageStores.referencePricing.mockReturnValue({ openai: { 'gpt-6.1-sol': quote } });
    usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: [
      row(), row(), { ...row(), day: '2026-10-16' },
    ] }, relays: [] });
    await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'openai' });
    expect(usageStores.referencePricing.mock.calls.map(([options]) => options?.at)).toEqual(['2026-10-17', '2026-10-16']);
    expect(usageStores.priceOverrides).toHaveBeenCalledTimes(1);
  });

  // PR #8489 review: ordinary provider APIs keep the SDK-reported amount, as local turn
  // accounting does; only DeepSeek (whose SDK cost ignores cache-hit pricing) is recomputed.
  it.each([
    { providerId: 'anthropic', expected: 0.25 },
    { providerId: 'deepseek', expected: 0.0034 },
  ])('keeps SDK cost for token-bearing $providerId rows unless the route is recomputed', async ({ providerId, expected }) => {
    usageStores.referencePricing.mockReturnValue({ [providerId]: { 'gpt-6.1-sol': { ...quote, providerId } } });
    const amount = await readEstimate(providerId, 0.25);
    expect(amount?.amount).toBeCloseTo(expected, 8);
    expect(amount?.currency).toBe('USD');
  });

  // PR #8489 review: cost-only deltas are valid ledger rows; a found quote must not turn them into $0.
  it('keeps the recorded SDK cost for rows without token counters', async () => {
    usageStores.referencePricing.mockReturnValue({ openai: { 'gpt-6.1-sol': quote } });
    usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: [{
      ...row(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0.25,
    }] }, relays: [] });
    const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'openai' }) as ProviderUsageHistoryView;
    expect(result.self.days[0]?.amount).toEqual({ amount: 0.25, currency: 'USD' });
  });
});

// PR #7772: settings classification must not renew the management page's fast-poll window
// or calculate usage. Existing management tests only read full owned/usage responses.
// Minimal input: active, paused, pending-only and duplicate-provider shares. Tier: unit.
describe('shared provider classification', () => {
  it.each(['local', 'same-account'] as const)('reads only established provider IDs without activating polling (%s)', async (entry) => {
    host.snapshot.mockReturnValue([
      { providerId: 'anthropic', members: [{ memberId: 'm1', status: 'active' }] },
      { providerId: 'openai', members: [{ memberId: 'm2', status: 'paused' }] },
      { providerId: 'anthropic', members: [{ memberId: 'm3', status: 'active' }] },
      { providerId: 'pending-only', members: [], requests: [{ requestId: 'r1' }] },
    ]);
    const raw = { action: 'shared-provider-ids' } as const;
    let result: unknown;
    if (entry === 'local') {
      const handle = vi.spyOn(ipcMain, 'handle');
      try {
        registerProviderShareIpc();
        const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
        result = await handler({} as Electron.IpcMainInvokeEvent, raw);
      } finally {
        handle.mockRestore();
      }
    } else {
      result = await executeProviderShareManagementCommand(parseProviderShareCommand(raw) as ProviderShareManagementCommand);
    }
    expect(result).toEqual({ ready: true, providerIds: ['anthropic', 'openai'] });
    expect(host.active).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(memberNotes.read).not.toHaveBeenCalled();
    expect(usageStores.memberTokenSnapshot).not.toHaveBeenCalled();
    expect(listProviders).not.toHaveBeenCalled();
  });
});

describe('provider share usage history wire budget', () => {
  it('caps the global row count even when the newest day alone has more rows', () => {
    const trimmed = trimProviderUsageHistory(historyWithRows(Array.from({ length: 5_001 }, (_, index) => historyRow(index))));
    expect(trimmed.self.days).toHaveLength(5_000);
    expect(trimmed.coverageStart).toBe('2026-10-17');
  });

  it('also trims by UTF-8 JSON bytes and reports the retained date', () => {
    const rows = Array.from({ length: 4_000 }, (_, index) => '模型-' + index + '-' + '很'.repeat(600))
      .map((model, index) => historyRow(index, model));
    const trimmed = trimProviderUsageHistory(historyWithRows(rows));
    expect(trimmed.self.days.length).toBeLessThan(rows.length);
    expect(Buffer.byteLength(JSON.stringify(trimmed), 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024 - 1_024);
    expect(trimmed.coverageStart).toBe('2026-10-17');
  });

  it('bounds ledger expansion and prices only the globally retained rows, preserving SDK costs and truncation', async () => {
    const rawRows = Array.from({ length: 5_001 }, (_, index) => {
      return { ...historyRow(index), sdkCostUsd: 0.25 };
    });
    usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: rawRows }, relays: [] });
    host.snapshot.mockReturnValue([{ providerId: 'anthropic', shareId: 's', members: [{ memberId: 'm1' }] }]);
    const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'anthropic' }) as ProviderUsageHistoryView;
    expect(usageStores.memberHistory).toHaveBeenCalledWith(new Set(['s']), {
      maxRows: 5_001, memberKeys: new Set([JSON.stringify(['s', 'm1'])]),
    });
    // Provider API rows with SDK costs keep them without building any reference catalog.
    expect(usageStores.referencePricing).not.toHaveBeenCalled();
    expect(result.self.days).toHaveLength(5_000);
    expect(result.self.days[0]?.amount).toEqual({ amount: 0.25, currency: 'USD' });
    expect(result.self.days[0]).not.toHaveProperty('sdkCostUsd');
    expect(result.coverageStart).toBe('2026-10-17');
  });
});

describe('remote task limit management payloads', () => {
  // idleMinutes：提供方的闲置收回时长，0 = 不收回(provider-sharing.md §3)。
  it.each([{ perDevice: 24 }, { total: 80 }, { perDevice: 16, total: 64 }, { idleMinutes: 0 }, { idleMinutes: 1440 }])('preserves only supplied fields in %j', limits => {
    expect(parseProviderShareCommand({ action: 'set-run-limits', limits })).toEqual({ action: 'set-run-limits', limits });
  });
  it.each([
    {}, { unknown: 1 }, { perDevice: '16' }, { perDevice: 0 }, { total: 1001 }, { total: 1.5 },
    { idleMinutes: -1 }, { idleMinutes: 1441 }, { idleMinutes: '30' },
  ])('rejects malformed patches %j', limits => {
    expect(() => parseProviderShareCommand({ action: 'set-run-limits', limits })).toThrow('INVALID_PARAMS');
  });
});

/* 测试价值：2026-10-19 用户备注；生产 parser/管理执行入口此前未覆盖备注。
 * 最小输入：空备注、超长/非字符串备注、不属于本机的成员，以及刷新中切账号。tier: unit。
 */
describe('member note management', () => {
  it('normalizes a single-line note and accepts clearing it', () => {
    expect(parseProviderShareCommand({ action: 'set-member-note', memberId: 'm1', note: ' Alice\nTeam ' }))
      .toEqual({ action: 'set-member-note', memberId: 'm1', note: 'Alice Team' });
    expect(parseProviderShareCommand({ action: 'set-member-note', memberId: 'm1', note: '' }))
      .toEqual({ action: 'set-member-note', memberId: 'm1', note: '' });
  });
  it.each([null, 123, 'x'.repeat(81)])('rejects an invalid note %j', (note) => {
    expect(() => parseProviderShareCommand({ action: 'set-member-note', memberId: 'm1', note })).toThrow('INVALID_PARAMS');
  });
  it.each(['local', 'same-account'] as const)('saves an existing member note without changing sharing authorization (%s)', async (entry) => {
    await expect(saveMemberNote(entry))
      .resolves.toEqual({ ok: true });
    expect(memberNotes.set).toHaveBeenCalledWith('m1', 'Alice', expect.any(Function));
    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('management');
    expect(api.setMember).not.toHaveBeenCalled();
  });
  /* PR #6445 discussion_r4312429158：本机真实 IPC 之前绕过管理入口的刷新。
   * 现有缺口：只测远程入口与已缺席成员，未测缓存仍有、刷新后退出的成员。
   * 最小输入：m1 在刷新后消失；或刷新期间切账号。结果必须拒绝保存，不写备注。
   * tier: unit；复用本文件内存 fixture 与生产 IPC / 管理入口，不新增网络或等待。
   * 单文件实测：50 项通过，1.58 秒。
   */
  it.each(['local', 'same-account'] as const)('refuses a note when the cached member has left before saving (%s)', async (entry) => {
    host.refresh.mockImplementationOnce(async () => { host.snapshot.mockReturnValue([]); });
    await expect(saveMemberNote(entry)).rejects.toThrow('NOT_FOUND');
    expect(memberNotes.set).not.toHaveBeenCalled();
  });
  it.each(['pending', 'switched'] as const)('refuses a local note when the account changes during refresh (%s)', async (boundary) => {
    host.refresh.mockImplementationOnce(async () => {
      if (boundary === 'pending') state.boundaryPending = true;
      else state.owner = 'owner-b';
    });
    await expect(saveMemberNote('local')).rejects.toThrow('PRECONDITION_FAILED');
    expect(memberNotes.set).not.toHaveBeenCalled();
  });
  it('refuses notes for absent members and a pending account transition', async () => {
    await expect(executeProviderShareManagementCommand({ action: 'set-member-note', memberId: 'absent', note: 'Alice' }))
      .rejects.toThrow('NOT_FOUND');
    host.refresh.mockImplementationOnce(async () => { state.boundaryPending = true; });
    await expect(executeProviderShareManagementCommand({ action: 'set-member-note', memberId: 'm1', note: 'Alice' }))
      .rejects.toThrow('PRECONDITION_FAILED');
    expect(memberNotes.set).not.toHaveBeenCalled();
  });
});

describe('same-account share management during account transitions', () => {
  it.each([
    createLink, ...mutations,
    { action: 'get-run-limits' },
    { action: 'set-run-limits', limits: { perDevice: 16, total: 64 } },
    { action: 'reset-run-limits' },
    { action: 'owned', range: '7d' },
    { action: 'shared-provider-ids' },
    { action: 'own-usage', providerId: 'anthropic', range: '7d' },
    { action: 'usage-history', providerId: 'anthropic' },
  ] satisfies ProviderShareManagementCommand[])('refuses $action at entry while teardown is pending', async (command) => {
    state.boundaryPending = true;
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(listProviders).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(api.createLink).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(mutations)('does not submit $action when teardown begins during membership refresh', async (command) => {
    host.refresh.mockImplementationOnce(async () => { state.boundaryPending = true; });
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(['provider lookup', 'identity card', 'link response'])('stops link creation when teardown begins during %s', async (stage) => {
    if (stage === 'provider lookup') listProviders.mockImplementationOnce(async () => { state.boundaryPending = true; return []; });
    if (stage === 'identity card') identityCard.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    if (stage === 'link response') api.createLink.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(identityCard).toHaveBeenCalledTimes(stage === 'provider lookup' ? 0 : 1);
    expect(api.createLink).toHaveBeenCalledTimes(stage === 'link response' ? 1 : 0);
    expect(host.active).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('discards a late $action result before changing local approval or membership state', async (command) => {
    const changeBoundary = async () => { state.boundaryPending = true; return { status: 'removed' }; };
    api.approve.mockImplementationOnce(changeBoundary);
    api.reject.mockImplementationOnce(changeBoundary);
    api.setMember.mockImplementationOnce(changeBoundary);
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.decision).not.toHaveBeenCalled();
    expect(host.member).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('management');
  });

  it('also discards a link response after a committed account switch', async () => {
    api.createLink.mockImplementationOnce(async () => { state.owner = 'owner-b'; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('executes $action once and updates local state when the account is stable', async (command) => {
    await expect(executeProviderShareManagementCommand(command)).resolves.toEqual({ ok: true });
    if (command.action === 'set-member') {
      expect(api.setMember).toHaveBeenCalledExactlyOnceWith('m1', 'remove');
      expect(host.member).toHaveBeenCalledExactlyOnceWith('m1', 'removed');
    } else if (command.action === 'approve' || command.action === 'reject') {
      expect(api[command.action]).toHaveBeenCalledExactlyOnceWith('r1');
      expect(host.decision).toHaveBeenCalledExactlyOnceWith('r1');
    }
  });

  it('creates and registers a link when the account is stable', async () => {
    await expect(executeProviderShareManagementCommand(createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link', linkId: LINK_ID });
    expect(api.createLink).toHaveBeenCalledTimes(1);
    expect(host.quiet).toHaveBeenCalledExactlyOnceWith('anthropic', LINK_ID);
    expect(remember).toHaveBeenCalledExactlyOnceWith('https://cindy.app/s#test-link', expect.any(String));
  });

  // PR #7744: exercise the production share-management entry, not only the scrubber.
  // provider-sharing.md §6 forbids sending org identity to the sharing service.
  it('uploads only the generic Cindy AI brand when creating an enterprise share link', async () => {
    listProviders.mockResolvedValue([{ id: 'xd', name: 'Cindy AI · Example Studio', connected: true, agents: ['codex'] }]);
    await executeProviderShareManagementCommand({ action: 'create-link', providerId: 'xd' });
    expect(api.createLink).toHaveBeenCalledExactlyOnceWith({
      providerId: 'xd', providerLabel: 'Cindy AI', deviceName: 'Cindy', identityCard: { card: 'test-identity-card' },
    });
  });

  it('rejects an old server before exposing or registering a remote link', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(host.active).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it('still creates local share links with an old server', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    const handle = vi.spyOn(ipcMain, 'handle');
    try {
      registerProviderShareIpc();
      const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
      await expect(handler({} as Electron.IpcMainInvokeEvent, createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link' });
      expect(host.quiet).not.toHaveBeenCalled();
      expect(remember).toHaveBeenCalledTimes(1);
    } finally {
      handle.mockRestore();
    }
  });

  it('does not register a link when saving its host ownership fails', async () => {
    host.quiet.mockRejectedValueOnce(new Error('ownership save failed'));
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow('ownership save failed');
    expect(remember).not.toHaveBeenCalled();
  });
});

/* 用户要求的型号权限：生产命令入口验证成员归属和切号；原来的备注、分享开关不覆盖型号范围。
 * 最小输入为另一供应商的同名成员以及读目录期间切号。unit，复用本文件进程内 fixture。 */
describe('remote model access management', () => {
  beforeEach(() => {
    listProviders.mockResolvedValue([{ id: 'anthropic', models: { 'claude-code': [
      { id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }, { id: 'stopped', disabled: true },
    ] } }]);
    host.snapshot.mockReturnValue([{ providerId: 'anthropic', requests: [], members: [{ memberId: 'm1' }] }]);
  });
  it.each([undefined, 'm1'])('saves remote model permissions in the managed owner scope: member=%s', async (memberId) => {
    const command = parseProviderShareCommand({ action: 'set-model-access', providerId: 'anthropic', memberId, models: ['small'] }) as ProviderShareManagementCommand;
    const result = await executeProviderShareManagementCommand(command);
    expect(modelAccess.set).toHaveBeenCalledWith('anthropic', ['small'], memberId, expect.any(Function), undefined);
    expect(result).toMatchObject({ version: 1, availableModels: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] });
    expect(api.setMember).not.toHaveBeenCalled();
  });
  // Unit regression for review 4326867264: the management command must offer every
  // enabled media model; the old fixture only covered chat models. Media-only providers
  // and duplicated ids must yield a usable, deduplicated authorization selection too.
  it.each([false, true])('offers media models alongside chat models or on their own: mediaOnly=%s', async (mediaOnly) => {
    listProviders.mockResolvedValue([{
      id: 'anthropic',
      models: mediaOnly ? {} : { codex: [{ id: 'chat', name: 'Chat' }], pi: [{ id: 'chat', name: 'Chat' }] },
      imageModels: [{ id: 'image', name: 'Image' }, { id: 'disabled-image', disabled: true }],
      videoModels: [{ id: 'video', name: 'Video' }],
      audioModels: [{ id: 'audio', name: 'Audio' }],
      embeddingModels: [{ id: 'embedding' }, { id: 'image', name: 'Image' }],
    }]);
    const result = await executeProviderShareManagementCommand({ action: 'get-model-access', providerId: 'anthropic', memberId: 'm1' });
    expect(result).toMatchObject({ availableModels: [
      ...(mediaOnly ? [] : [{ id: 'chat', name: 'Chat' }]),
      { id: 'image', name: 'Image' }, { id: 'video', name: 'Video' },
      { id: 'audio', name: 'Audio' }, { id: 'embedding', name: 'embedding' },
    ] });
  });
  it('refuses to modify a person who belongs to a different provider', async () => {
    host.snapshot.mockReturnValue([{ providerId: 'other', members: [{ memberId: 'm1' }] }]);
    await expect(executeProviderShareManagementCommand({ action: 'set-model-access', providerId: 'anthropic', memberId: 'm1', models: [] })).rejects.toThrow('NOT_FOUND');
    expect(modelAccess.set).not.toHaveBeenCalled();
  });
  it('does not save a delayed model selection into a newly signed-in account', async () => {
    listProviders.mockImplementationOnce(async () => { state.owner = 'owner-b'; return [{ id: 'anthropic', models: {} }]; });
    await expect(executeProviderShareManagementCommand({ action: 'set-model-access', providerId: 'anthropic', models: [] })).rejects.toThrow('PRECONDITION_FAILED');
    expect(modelAccess.set).not.toHaveBeenCalled();
  });
  it.each([['small', 'small'], [false], {}, undefined])('rejects invalid selection payload %#', (models) => {
    expect(() => parseProviderShareCommand({ action: 'set-model-access', providerId: 'anthropic', models })).toThrow('INVALID_PARAMS');
  });
});

/* 分享可见性：生产管理/IPC入口补足远程设置与受邀者在途撤权、旧端返回差异。tier: unit。 */
describe('share visibility management and guest query', () => {
  it('saves only the requested switch via the same-account management entry', async () => {
    visibility.set.mockImplementation(async (_id, patch, assertCurrent) => { assertCurrent(); return { quota: false, usage: true, ...patch }; });
    const result = await executeProviderShareManagementCommand(parseProviderShareCommand({ action: 'set-visibility', providerId: 'anthropic', visibility: { quota: true } }) as ProviderShareManagementCommand);
    expect(result).toMatchObject({ quota: true, usage: true });
    expect(visibility.set).toHaveBeenCalledWith('anthropic', { quota: true }, expect.any(Function));
    expect(() => parseProviderShareCommand({ action: 'set-visibility', providerId: 'anthropic', visibility: { quota: 'true' } })).toThrow('INVALID_PARAMS');
  });
  it.each(['revision', 'owner', 'removed', 'old-version', 'old-unscoped'])('rejects a stale or unsupported guest response: %s', async (change) => {
    guest.share = { shareId: 's', memberId: 'm', status: 'active', hostOnline: true };
    guest.revision = 0;
    const invoke = vi.fn(async () => {
      if (change === 'revision') guest.revision += 2; // pause then resume: same current share, different generation
      if (change === 'owner') state.owner = 'owner-b';
      if (change === 'removed') guest.share = null;
      return { ok: true, result: change === 'old-unscoped' ? { version: 1, capabilities: { quota: false, usage: true }, status: { quota: 'disabled', usage: 'ready' }, quota: null, usage: { todayKey: '2026-10-19', coverageStart: null, parties: [] } } : {} } as const;
    });
    stopProviderShareRuntime(); startProviderShareRuntime(vi.fn(), { invoke });
    const handle = vi.spyOn(ipcMain, 'handle');
    registerProviderShareIpc();
    const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
    handle.mockRestore();
    await expect(handler({} as Electron.IpcMainInvokeEvent, { action: 'insights', shareId: 's', includeUsage: false })).rejects.toThrow(
      change.startsWith('old-') ? 'UNSUPPORTED_CAPABILITY' : change === 'owner' ? 'PRECONDITION_FAILED' : 'PERMISSION_DENIED');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('share:s', 'provider-share:insights:v1', [{ version: 1, includeUsage: false }], expect.any(Object));
  });
});

describe('subscription Fast management through the owner command', () => {
  const command = { action: 'set-fast-policy', providerId: 'openai', allowFast: false } as const;
  const subscription = { id: 'openai', auth: { method: 'oauth', native: 'codex' } };

  it('refreshes local catalogs even when the user has not started device-link sharing', async () => {
    stopProviderShareRuntime();
    listProviders.mockResolvedValue([subscription]);
    await expect(executeProviderShareManagementCommand(command)).resolves.toEqual({ supported: true, allowFast: false });
    expect(localBroadcast).toHaveBeenCalledWith('maker:provider:changed', {});
  });

  it('persists a subscription restriction and publishes the catalog before awaiting the native update', async () => {
    listProviders.mockResolvedValue([subscription]);
    fastPolicy.changed.mockImplementation(async () => {
      expect(fastPolicy.allows('openai')).toBe(false);
      expect(fastPolicy.publish).toHaveBeenCalledWith('openai');
      throw Error('native still busy');
    });
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow('native still busy');
    expect(fastPolicy.set).toHaveBeenCalledWith('openai', false, expect.any(Function));
    fastPolicy.changed.mockResolvedValue(undefined);
    await expect(executeProviderShareManagementCommand(command)).resolves.toEqual({ supported: true, allowFast: false });
  });

  it('rejects a custom API named openai and requires a real boolean', async () => {
    listProviders.mockResolvedValue([{ ...subscription, auth: { method: 'apiKey' } }]);
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow('INVALID_PARAMS');
    expect(fastPolicy.set).not.toHaveBeenCalled();
    expect(() => parseProviderShareCommand({ ...command, allowFast: 'false' })).toThrow('INVALID_PARAMS');
  });

  it('does not persist after the owner changes during catalog lookup', async () => {
    listProviders.mockImplementation(async () => { state.owner = 'owner-b'; return [subscription]; });
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow('PRECONDITION_FAILED');
    expect(fastPolicy.set).not.toHaveBeenCalled();
    expect(fastPolicy.publish).not.toHaveBeenCalled();
  });
});

// Exercise the production scheduler with deferred fake network work, never real shares.
it('coalesces pending syncs, ignores unchanged polling and retains periodic refresh', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  standby.publish.mockImplementationOnce(() => blocked);
  const events = vi.mocked(startProviderShareHost).mock.lastCall![0];
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  try {
    events.changed(host.snapshot());
    await flush();
    expect(standby.publish).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) events.changed(host.snapshot());
    await flush();
    finish(); await flush();
    expect(standby.publish).toHaveBeenCalledTimes(1);
    let release!: () => void;
    standby.publish.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    // The timer was installed before fake timers, so restart with the fake clock.
    startProviderShareRuntime(vi.fn());
    const current = vi.mocked(startProviderShareHost).mock.lastCall![0];
    current.changed(host.snapshot()); await flush();
    expect(standby.publish).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 20; i++) {
      host.snapshot.mockReturnValue([{ shareId: 'share', members: [{ memberId: 'm1', joinedAt: String(i), status: 'active' }] }]);
      current.changed(host.snapshot());
    }
    await vi.advanceTimersByTimeAsync(180_000);
    expect(standby.publish).toHaveBeenCalledTimes(2);
    release(); await flush();
    expect(standby.publish).toHaveBeenCalledTimes(3);
    expect(standby.publish.mock.lastCall![0][0].members[0].joinedAt).toBe('19');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(standby.publish).toHaveBeenCalledTimes(4);
  } finally { finish(); stopProviderShareRuntime(); vi.useRealTimers(); }
});
