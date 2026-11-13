/**
 * 运行期单例按账号隔离：换账号后冷却、目录缓存不沿用上一个账号的。
 */
import type { ProviderShareReceived } from '@cindy/device-link';
import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProviderGroupConfig, providerGroupSummaryForWire, type ProviderGroupConfig } from '../../../shared/providerGroup.js';
import { PROVIDER_GROUP_PICK_QUICK_MS } from '../router.js';
import { PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS, providerGroupMemberUsageState } from '../usage.js';
import { createGroupContinuityExecutor } from '../continuityExecutor.js';
import type { GroupContinuityGrant } from '../../../shared/providerGroupContinuity.js';
import { createProviderGroupService, type ProviderGroupServiceDeps } from '../service.js';
import type { ProviderGroupBinding } from '../bindings.desktop.js';

let owner = 'owner-a';
const io = vi.hoisted(() => ({
  local: vi.fn(async () => [] as ProviderView[]),
  devices: vi.fn(),
  catalog: vi.fn(),
  catalogState: vi.fn(),
  invoke: vi.fn(),
  shares: vi.fn(() => [] as readonly ProviderShareReceived[]),
  group: vi.fn(() => null as ProviderGroupConfig | null),
  status: vi.fn(() => 'online'),
  self: vi.fn(() => 'self'),
  closeEpoch: vi.fn(() => 0),
  offlineDirect: vi.fn(() => false),
  localAccountPush: undefined as (() => void) | undefined,
  accountPush: undefined as ((deviceId: string, channel: string) => void) | undefined,
}));

// Keep the real account runtime; capture only its event subscription so both
// local and remote invalidation exercise the production directory/cache owner.
vi.mock('../../subscription-accounts/runtime.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  onSubscriptionAccountsChanged: (listener: () => void) => { io.localAccountPush = listener; return () => {}; },
}));
// The account runtime now statically imports route admission. These directory/cache tests never
// dispatch accounts; keep that permission leaf fail-closed without loading share/fast-policy assembly.
vi.mock('../../subscription-accounts/legacyAccountAccess.js', () => ({
  legacyCodexAccountCanRun: () => false,
  openAiRouteAllowsModel: () => false,
  setLegacyCodexAccountPaused: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => owner, isAppSessionBoundaryPending: () => false }));
vi.mock('../../device-link/providerShareGuest.js', () => ({ getReceivedShares: io.shares,
  captureProviderShareGroupRecovery: () => async () => undefined }));
vi.mock('../../device-link/ipc.js', () => ({ handleListDevices: io.devices, defaultDeps: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ onRemotePushChannel: (listener: (deviceId: string, channel: string) => void) => { io.accountPush = listener; return () => {}; }, remoteBackgroundInvoke: io.invoke, getDeviceLinkStatus: io.status,
  getSelfDeviceId: io.self, getRemoteLinkCloseEpoch: io.closeEpoch, hasOfflineDirectPath: io.offlineDirect }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://device-link.invalid' }));
vi.mock('../../device-link/controllerPlatform.js', () => ({ isMobilePlatform: () => false }));
vi.mock('../../device-link/deviceName.js', () => ({ deviceName: () => 'This computer' }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: io.local }),
}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: io.catalog,
  readDeviceProviderCatalog: io.catalogState }));
vi.mock('../bindings.desktop.js', () => ({ listProviderGroupBindings: () => ({}) }));
vi.mock('../store.js', () => ({ readProviderGroup: io.group }));
vi.mock('../coolingStore.js', () => ({ readProviderGroupCooling: () => ({}), writeProviderGroupCooling: vi.fn() }));
// Heavy leaves used only by service's failover/auto-resume paths, which these runtime
// cases never execute. The real service/runtime/client/executor/reader stay in place.
vi.mock('../../maker-ipc/interruptedTurnAutoResume.js', () => ({ interruptedTurnResumeDelayMs: () => 0 }));
vi.mock('../../shared/agentInputQueue.js', () => ({ USAGE_LIMIT_RESET_AUTO_RESUME_REASON: 'usage-limit-reset' }));
vi.mock('../failurePolicy.js', () => ({
  decideProviderGroupFailure: vi.fn(), describeProviderGroupFailure: vi.fn(),
  providerGroupUnavailableError: vi.fn(), providerGroupFailureSignals: vi.fn(),
  PROVIDER_GROUP_SUPERSEDED_ERROR: 'PROVIDER_GROUP_SUPERSEDED',
  PROVIDER_GROUP_UNAVAILABLE_ERROR: 'PROVIDER_GROUP_UNAVAILABLE',
}));

const { getProviderGroupDirectory, getProviderGroupOwnerScope, getProviderGroupRouter, setProviderGroupClaudeUsageReader, setProviderGroupCodexUsageReader,
  getProviderGroupApplicationLoad, setProviderGroupApplicationLoadListener, getProviderGroupRemoteGroups } = await import('../runtime.js');
const { readDeviceProviderCatalog, readDeviceProviderViews } = await vi.importActual<typeof import('../../remote-agent/controller/deviceCatalog.js')>(
  '../../remote-agent/controller/deviceCatalog.js',
);
io.catalogState.mockImplementation(async (...args: unknown[]) => ({
  views: await (io.catalog as unknown as (...args: unknown[]) => Promise<ProviderView[]>)(...args),
  stale: false,
}));
const { captureProviderMetadataContinuityScope, invokeProviderMetadataContinuity, invalidateProviderMetadataContinuity } = await vi.importActual<
  typeof import('../../device-link/providerMetadataContinuity.js')>('../../device-link/providerMetadataContinuity.js');

afterEach(() => {
  setProviderGroupClaudeUsageReader(null);
  setProviderGroupCodexUsageReader(null);
  io.group.mockReset();
  io.catalogState.mockReset();
  io.catalogState.mockImplementation(async (...args: unknown[]) => ({
    views: await (io.catalog as unknown as (...args: unknown[]) => Promise<ProviderView[]>)(...args),
    stale: false,
  }));
  vi.useRealTimers();
});

describe('provider group runtime', () => {
  // PR #7697: local group scheduling must count app bindings without sending
  // them through a loopback remote lease. A remote group's binding is excluded.
  it('counts local application bindings in the owning group only', () => {
    owner = 'local-app-group-owner';
    const load = getProviderGroupApplicationLoad();
    const native = { isTurnRunning: () => true, onEvent: () => () => {}, onStatusChange: () => () => {} };
    load.track('local-app', { providerId: 'member', groupAssigned: true,
      groupBinding: { providerId: 'group', memberKey: 'device:member' } }, native);
    load.track('other-group-app', { providerId: 'member', groupAssigned: true,
      groupBinding: { providerId: 'group', memberKey: 'device:member', groupDeviceId: 'other' } }, native);
    expect(getProviderGroupRouter().running('group', 'device:member')).toBe(1);
  });
  it('follows login and account changes without re-registering IPC or accepting old application callbacks', () => {
    owner = 'signed-out-load';
    getProviderGroupApplicationLoad();
    const changed = vi.fn();
    setProviderGroupApplicationLoadListener(changed);
    const native = { isTurnRunning: () => true, onEvent: () => () => {}, onStatusChange: () => () => {} };
    owner = 'first-load-owner';
    const first = getProviderGroupApplicationLoad();
    first.track('first', { providerId: 'p' }, native);
    expect(changed).toHaveBeenLastCalledWith('first');
    expect(getProviderGroupApplicationLoad().runningProviders()).toEqual(['p']);
    owner = 'second-load-owner';
    expect(getProviderGroupApplicationLoad().runningProviders()).toEqual([]);
    changed.mockClear();
    first.track('late', { providerId: 'p' }, native);
    expect(changed).not.toHaveBeenCalled();
    getProviderGroupApplicationLoad().track('second', { providerId: 'q' }, native);
    expect(changed).toHaveBeenCalledExactlyOnceWith('second');
    expect(getProviderGroupApplicationLoad().runningProviders()).toEqual(['q']);
    setProviderGroupApplicationLoadListener(() => {});
  });
  // Unit / provider-sharing.md §5.1 (2026-11-02): resolveMembers must reject a signed-out shared computer,
  // where groupAssigned tasks run directly. Existing quota fixtures mock the catalog and miss guest projection.
  // Minimal regression: connected:false + groupSize:3 on an active share; exercise the real catalog reader.
  it.each([
    [false, { state: 'unavailable', reason: 'disconnected' }],
    [true, { state: 'ok', view: { connected: true } }],
  ] as const)('judges a shared member by its own connection state (%s)', async (connected, expected) => {
    owner = `member-state-owner-${connected}`;
    io.catalog.mockImplementationOnce(readDeviceProviderViews);
    io.invoke.mockResolvedValueOnce({ ok: true, result: { providers: [{
      id: 'anthropic', name: 'Anthropic', agents: ['claude-code'], models: { 'claude-code': [] },
      connected, remoteInvocationEnabled: true, groupSize: 3,
    }] } });
    io.shares.mockReturnValueOnce([{
      shareId: 's1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic',
      hostDeviceId: 'host', deviceName: 'Cindy', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
      status: 'active', hostOnline: true, hostCapable: true,
    }]);
    const config = normalizeProviderGroupConfig({ members: [
      { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' },
    ] }, 'anthropic')!;
    expect(await getProviderGroupDirectory().resolveMembers('anthropic', config)).toMatchObject([expected]);
  });
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

describe('remote group continuity wiring', () => {
  it('serves the last acknowledged pick config when the owner directory is unavailable', async () => {
    owner = 'continuity-wiring-owner';
    io.invoke.mockReset();
    io.catalog.mockReset();
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'executor', providerId: 'openai' }] }, 'openai')!;
    io.invoke.mockResolvedValueOnce({ ok: true, result: { kind: 'member',
      member: { key: config.members[0].key, kind: 'device', agentDeviceId: 'executor', providerId: 'openai' },
      label: 'M', continuity: { id: 'grant-1', remainingMs: 1_800_000, config } } });
    const groups = getProviderGroupRemoteGroups();
    expect(await groups.pick('group-owner', { sessionId: 's1', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [] })).toMatchObject({ kind: 'member' });
    io.catalog.mockRejectedValueOnce(new Error('directory offline'));
    expect(await groups.readGroup('group-owner', 'openai')).toBeUndefined();
    expect(await groups.readGroup('group-owner', 'openai', { allowSnapshot: true })).toEqual(config);
    const snapshot = groups.readSnapshotGroup!('group-owner', 'openai');
    expect(snapshot).toBeInstanceOf(Promise);
    // Mirrors service.ts's never-run task path; a sync config would throw here.
    await expect(snapshot.catch(() => null)).resolves.toEqual(config);
    io.catalog.mockResolvedValueOnce([]);
    expect(await groups.readGroup('other-owner', 'openai')).toBeNull();
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup (used by service.assignBeforeStart
  //   -> assignFromRemoteGroup for a new task) racing a first group pick that creates the local
  //   routing generation for the same owner/provider.
  // - Rule: provider-groups.md short-outage section: a live directory reply is the owner's current
  //   membership; only a replaced generation may keep it from clearing acknowledged routes.
  // - Gap: the post-read generation guard compared "no generation yet" with the generation the
  //   concurrent pick created, so a valid live config was discarded and the new task fell back to
  //   running directly on the group owner instead of a member.
  // - Minimal failing input: readGroup({allowSnapshot:true}) in flight, one concurrent pick creates
  //   the generation, then the live directory reply carries the group summary.
  // - Tier: unit (real runtime/client/directory wiring; transport and directory reply controlled).
  it('keeps a live group config for a new task when a concurrent pick creates the routing generation', async () => {
    owner = 'continuity-live-generation-owner';
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.catalogState.mockReset();
    io.status.mockReturnValue('online');
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'live-executor', providerId: 'openai' }] }, 'openai')!;
    const member = config.members[0]!;
    const releases: Array<(views: ProviderView[]) => void> = [];
    io.catalogState.mockImplementation(() => new Promise(resolve => {
      releases.push(views => resolve({ views, stale: false }));
    }));
    let finishPick!: () => void;
    const pickPending = new Promise<void>(resolve => { finishPick = resolve; });
    io.invoke.mockImplementation(async (_device: string, _channel: string, args: unknown[]) => {
      const request = args[0] as { action?: string };
      if (request.action !== 'pick') return { ok: true, result: {} };
      await pickPending;
      return { ok: true, result: { kind: 'member', label: 'M',
        member: { key: member.key, kind: member.kind, agentDeviceId: member.agentDeviceId,
          providerId: member.providerId },
        continuity: { id: 'live-generation-grant', remainingMs: 1_800_000, config } } };
    });
    const groups = getProviderGroupRemoteGroups();
    const newTaskRead = groups.readGroup('live-generation-owner', 'openai', { allowSnapshot: true });
    // An existing task's binding reconciliation stays conservative instead of
    // acting on a reply which predates the routes a concurrent pick installed.
    const existingTaskRead = groups.readGroup('live-generation-owner', 'openai');
    const concurrentPick = groups.pick('live-generation-owner', { sessionId: 'live-generation-task',
      providerId: 'openai', agentKind: 'codex', model: 'model', exclude: [], allowOffline: true });
    expect(await groups.readSnapshotGroup!('live-generation-owner', 'openai')).toBeNull();
    const view: ProviderView & { group: ReturnType<typeof providerGroupSummaryForWire> } = {
      id: 'openai', name: 'OpenAI', source: 'builtin',
      agents: ['codex'], models: { codex: [] },
      routing: { codex: { upstream: 'https://api.openai.com', authStrategy: 'oauth-token' } },
      auth: { method: 'oauth', native: 'codex' },
      connected: true, group: providerGroupSummaryForWire(config) };
    for (const release of releases) release([view]);
    await expect(newTaskRead).resolves.toEqual(config);
    await expect(existingTaskRead).resolves.toBeUndefined();
    finishPick();
    await expect(concurrentPick).resolves.toMatchObject({
      kind: 'member', member: { agentDeviceId: 'live-executor' },
    });
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().pick (used by provider-group/service.ts).
  // - Rule: provider-groups.md short-outage section: a temporarily unavailable O must not erase a
  //   context already acknowledged by O and M; a new task may still be admitted on M.
  // - Coverage gap: existing wiring cases only cover directory read failures, not an O handler
  //   that is not ready yet ([UNAVAILABLE] from dispatch).
  // - Minimal failing input: acknowledge one pick, then make O answer [UNAVAILABLE] for the next
  //   new-task pick while M still accepts the context.
  // - Tier: unit (real continuity client/wiring; only transport is mocked).
  it('keeps acknowledged contexts and admits a new task when the owner is not ready yet', async () => {
    owner = 'continuity-unavailable-owner';
    io.invoke.mockReset();
    io.catalog.mockReset();
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'executor', providerId: 'openai' }] }, 'openai')!;
    const member = config.members[0]!;
    const grant: GroupContinuityGrant = { id: 'grant-unavailable', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    const executor = createGroupContinuityExecutor({ capture: () => () => true,
      inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
      wall: Date.now, mono: () => performance.now() });
    const ack = await executor.handle('group-owner', { action: 'continuity-prepare', grant });
    let ownerReady = true;
    io.invoke.mockImplementation(async (device: string, _channel: string, args: unknown[], options?: { preSend?: () => void }) => {
      options?.preSend?.();
      if (device === 'group-owner') {
        if (!ownerReady) return { ok: false, error: { code: 'IPC_ERROR',
          message: '[UNAVAILABLE] provider groups are not ready yet' } };
        return { ok: true, result: { kind: 'member', label: 'M',
          member: { key: member.key, kind: member.kind, agentDeviceId: member.agentDeviceId, providerId: member.providerId },
          continuity: { ...ack, config } } };
      }
      return { ok: true, result: await executor.handle('C', args[0]) };
    });
    const groups = getProviderGroupRemoteGroups();
    expect(await groups.pick('group-owner', { sessionId: 'warm', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).toMatchObject({ kind: 'member' });
    ownerReady = false;
    expect(await groups.pick('group-owner', { sessionId: 'new-task', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).toMatchObject({ kind: 'member' });
    // Existing tasks still wait for the owner; a temporary "not ready" answer must
    // not retire the context a later new task may still use.
    await expect(groups.pick('group-owner', { sessionId: 'existing-task', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: false })).rejects.toThrow('UNAVAILABLE');
    expect(await groups.readSnapshotGroup!('group-owner', 'openai')).toEqual(config);
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup / pick (used by service.ts).
  // - Rule: provider-groups.md short-outage section: a live read that confirms the group is gone
  //   retires that target's directory and routing context immediately; other targets stay.
  // - Gap: existing wiring cases cover an unavailable read, not a successful read proving deletion
  //   followed by an owner outage that would otherwise reuse the stale pick config.
  // - Minimal failing input: acknowledged pick with continuity, live directory without the provider,
  //   then an offline new-task pick for that provider.
  // - Tier: unit (real continuity client/wiring; only transport/directory are mocked).
  it('retires only the deleted group routing contexts after a live directory read', async () => {
    owner = 'continuity-group-deleted-owner';
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.status.mockReturnValue('online');
    const configFor = (providerId: string) => normalizeProviderGroupConfig({
      strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'executor', providerId }],
    }, providerId)!;
    const openai = configFor('openai');
    const anthropic = configFor('anthropic');
    let grant = 0;
    io.invoke.mockImplementation(async (_device: string, _channel: string, args: unknown[]) => {
      const request = args[0] as { action?: string; providerId?: string; id?: string };
      if (request.action === 'pick') {
        if (io.status() === 'offline') throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
        const config = request.providerId === 'anthropic' ? anthropic : openai;
        return { ok: true, result: { kind: 'member', label: 'M', member: config.members[0],
          continuity: { id: `grant-${++grant}`, remainingMs: 1_800_000, config } } };
      }
      if (request.action === 'continuity-inspect' || request.action === 'continuity-admit') {
        return { ok: true, result: { id: request.id, remainingMs: 1_800_000, running: 0 } };
      }
      return { ok: true, result: {} };
    });
    const groups = getProviderGroupRemoteGroups();
    for (const providerId of ['openai', 'anthropic']) {
      expect(await groups.pick('group-owner', { sessionId: `warm-${providerId}`, providerId,
        agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).toMatchObject({ kind: 'member' });
    }
    expect(await groups.readSnapshotGroup!('group-owner', 'openai')).toEqual(openai);
    expect(await groups.readSnapshotGroup!('group-owner', 'anthropic')).toEqual(anthropic);

    io.catalog.mockResolvedValueOnce([]);
    expect(await groups.readGroup('group-owner', 'openai')).toBeNull();
    expect(await groups.readSnapshotGroup!('group-owner', 'openai')).toBeNull();
    expect(await groups.readSnapshotGroup!('group-owner', 'anthropic')).toEqual(anthropic);

    io.status.mockReturnValue('offline');
    await expect(groups.pick('group-owner', { sessionId: 'after-delete', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).rejects.toThrow('owner offline');
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup (used by service.ts), actual
  //   Main invokeProviderMetadataContinuity + readDeviceProviderCatalog + directory cache.
  // - Rule: a cached directory or a stale continuity reply is not the owner's confirmation
  //   that a group was deleted; only a current live read may retire acknowledged routes.
  // - Gap: readGroup treated any successful array reply without the provider as deletion.
  // - Minimal failing input: confirm a pick, then return an empty stale reply (or reuse the
  //   15s local directory cache) after the physical read is unavailable.
  // - Tier: unit integration (real runtime/client/directory/reader; transport and clock only).
  it.each([
    { lane: 'stale Main reply', invalidate: true, stale: true },
    { lane: 'local directory cache', invalidate: false, stale: false },
  ])('does not retire acknowledged routes from a $lane', async ({ lane, invalidate, stale }) => {
    owner = 'continuity-directory-' + lane.replaceAll(' ', '-');
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.catalogState.mockReset();
    io.status.mockReturnValue('online');
    invalidateProviderMetadataContinuity();
    const target = 'continuity-directory-O-' + lane.replaceAll(' ', '-');
    getProviderGroupDirectory().invalidate(target);
    const configFor = (providerId: string) => normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true,
      allowFast: false, members: [{ kind: 'device', agentDeviceId: 'executor', providerId }] }, providerId)!;
    const openai = configFor('openai'), anthropic = configFor('anthropic');
    const oldResult = { providers: [], providerContinuity: { stale: false, remainingMs: 1_800_000 } };
    let directoryFails = false;
    let lastDirectory: unknown;
    io.catalogState.mockImplementation(async (...args: unknown[]) =>
      readDeviceProviderCatalog(args[0] as Parameters<typeof readDeviceProviderCatalog>[0],
        args[1] as string, args[2] as Parameters<typeof readDeviceProviderCatalog>[2]));
    io.invoke.mockImplementation(async (device: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
      options?.preSend?.();
      if (channel === 'maker:provider:list') {
        const reply = await invokeProviderMetadataContinuity(device, channel, args, async () => {
          if (directoryFails) throw Object.assign(new Error('directory timeout'), { code: 'TIMEOUT' });
          return { ok: true, result: oldResult };
        });
        if (reply.ok) lastDirectory = reply.result;
        return reply;
      }
      const request = args[0] as { action?: string; providerId?: string; id?: string };
      if (request.action === 'pick') {
        const config = request.providerId === 'anthropic' ? anthropic : openai;
        return { ok: true, result: { kind: 'member', label: 'M', member: config.members[0],
          continuity: { id: 'grant-' + request.providerId, remainingMs: 1_800_000, config } } };
      }
      if (request.action === 'continuity-inspect' || request.action === 'continuity-admit') {
        return { ok: true, result: { id: request.id, remainingMs: 1_800_000, running: 0 } };
      }
      throw new Error('Unexpected transport');
    });
    const groups = getProviderGroupRemoteGroups();
    expect(await groups.readGroup(target, 'openai', { allowSnapshot: true })).toBeNull();
    for (const providerId of ['openai', 'anthropic']) {
      expect(await groups.pick(target, { sessionId: 'warm-' + providerId, providerId,
        agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).toMatchObject({ kind: 'member' });
    }
    expect(await groups.readSnapshotGroup!(target, 'openai')).toEqual(openai);
    expect(await groups.readSnapshotGroup!(target, 'anthropic')).toEqual(anthropic);

    if (invalidate) getProviderGroupDirectory().invalidate(target);
    directoryFails = true;
    expect(await groups.readGroup(target, 'openai', { allowSnapshot: true })).toBeUndefined();
    expect(lastDirectory).toMatchObject({ providers: [], providerContinuity: { stale } });
    expect(await groups.readSnapshotGroup!(target, 'openai')).toEqual(openai);
    expect(await groups.readSnapshotGroup!(target, 'anthropic')).toEqual(anthropic);
  });
  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup/pick (used by service.ts).
  // - Rule: provider-groups.md short-outage section: a late directory result from an old local
  //   account/endpoint generation must not clear the new generation's acknowledged rows for the
  //   same remote owner/provider.
  // - Gap: readGroup awaited the directory facade and then called forgetGroup using the current
  //   local state, so a late old-scope null could clear a newer scope's context.
  // - Minimal failing input: A read pending, switch to B, warm B's same owner/provider rows,
  //   then deliver A's successful missing-group result.
  // - Tier: unit (real continuity client/wiring; only transport/directory are mocked).
  it('does not let a late old-generation readGroup clear newer routing rows', async () => {
    owner = 'continuity-scope-owner-a';
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.status.mockReturnValue('online');
    const configFor = (providerId: string) => normalizeProviderGroupConfig({
      strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'executor', providerId }],
    }, providerId)!;
    const openai = configFor('openai');
    const anthropic = configFor('anthropic');
    let resolveCatalog!: (value: ProviderView[]) => void;
    const catalogGate = new Promise<ProviderView[]>(resolve => { resolveCatalog = resolve; });
    io.catalog.mockImplementationOnce(() => catalogGate);
    const groups = getProviderGroupRemoteGroups();
    const pendingRead = groups.readGroup('scope-owner', 'openai');

    owner = 'continuity-scope-owner-b';
    let grant = 0;
    io.invoke.mockImplementation(async (_device: string, _channel: string, args: unknown[]) => {
      const request = args[0] as { action?: string; providerId?: string; id?: string };
      if (request.action === 'pick') {
        if (io.status() === 'offline') throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
        const config = request.providerId === 'anthropic' ? anthropic : openai;
        return { ok: true, result: { kind: 'member', label: 'M', member: config.members[0],
          continuity: { id: `scope-grant-${++grant}`, remainingMs: 1_800_000, config } } };
      }
      if (request.action === 'continuity-inspect' || request.action === 'continuity-admit') {
        return { ok: true, result: { id: request.id, remainingMs: 1_800_000, running: 0 } };
      }
      return { ok: true, result: {} };
    });
    for (const providerId of ['openai', 'anthropic']) {
      expect(await groups.pick('scope-owner', { sessionId: `warm-${providerId}`, providerId,
        agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).toMatchObject({ kind: 'member' });
    }
    expect(await groups.readSnapshotGroup!('scope-owner', 'openai')).toEqual(openai);
    expect(await groups.readSnapshotGroup!('scope-owner', 'anthropic')).toEqual(anthropic);

    resolveCatalog([]);
    expect(await pendingRead).toBeUndefined();
    expect(await groups.readSnapshotGroup!('scope-owner', 'openai')).toEqual(openai);
    expect(await groups.readSnapshotGroup!('scope-owner', 'anthropic')).toEqual(anthropic);

    io.status.mockReturnValue('offline');
    expect(await groups.pick('scope-owner', { sessionId: 'after-old-read', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true }))
      .toMatchObject({ kind: 'member', member: { agentDeviceId: 'executor' } });
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup (used by service.ts) with the
  //   actual metadata capture/reader and only the IPC transport controlled.
  // - Rule: a successful live directory read must not be discarded merely because an
  //   unregistered target cannot enter the offline metadata capture at the 1024 target cap.
  // - Gap: the unconditional post-await targetScope guard bound this online read to the
  //   fail-closed offline capture.
  // - Minimal failing input: fill the real target registry, then return a valid provider list
  //   for a new owner through the actual live-only reader path.
  // - Tier: unit/integration (real runtime factory, capture and reader; only transport mocked).
  it('keeps a live directory read when the offline metadata target table is full', async () => {
    owner = 'continuity-capacity-owner';
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.status.mockReturnValue('online');
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'capacity-executor', providerId: 'openai' }] }, 'openai')!;
    let livePicks = 0;
    io.invoke.mockImplementation(async (device: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:provider:list') {
        return invokeProviderMetadataContinuity(device, channel, args, async () => ({ ok: true, result: {
          providers: [{ id: 'openai', name: 'OpenAI', agents: ['codex'], models: { codex: [] },
            connected: true, remoteInvocationEnabled: true, group: providerGroupSummaryForWire(config) }],
        } }));
      }
      if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: string }).action === 'pick') {
        if (io.status() === 'offline') throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
        livePicks += 1;
        return { ok: true, result: { kind: 'member', member: config.members[0], label: 'M' } };
      }
      return { ok: true, result: {} };
    });
    for (let i = 0; i < 1100; i += 1) captureProviderMetadataContinuityScope(`capacity-target-${i}`);
    expect(captureProviderMetadataContinuityScope('continuity-capacity-owner')()).toBe(false);
    io.catalog.mockImplementationOnce(readDeviceProviderViews);
    const groups = getProviderGroupRemoteGroups();
    // service.assignFromRemoteGroup would fall back to this snapshot; with no
    // prepared row it is null, so an undefined live read leaves the task on O.
    expect(await groups.readSnapshotGroup!('continuity-capacity-owner', 'openai')).toBeNull();
    expect(await groups.readGroup('continuity-capacity-owner', 'openai')).toEqual(config);
    expect(await groups.pick('continuity-capacity-owner', { sessionId: 'capacity-online', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true }))
      .toMatchObject({ kind: 'member', member: { agentDeviceId: 'capacity-executor' } });
    expect(livePicks).toBe(1);
    // The online pick is authoritative, but a full offline capture must not retain a row.
    expect(await groups.readSnapshotGroup!('continuity-capacity-owner', 'openai')).toBeNull();
    io.status.mockReturnValue('offline');
    await expect(groups.pick('continuity-capacity-owner', { sessionId: 'capacity-offline', providerId: 'openai',
      agentKind: 'codex', model: 'model', exclude: [], allowOffline: true })).rejects.toThrow('owner offline');
  });

  // Test value
  // - Production entry: getProviderGroupRemoteGroups().readGroup (used by service.ts).
  // - Rule: provider-groups.md short-outage section: a directory snapshot is not the owner's
  //   current membership confirmation; a stale reply may predate a live-picked member.
  // - Gap: readGroup used a stale fallback catalog as a live group config, so service's
  //   binding reconciliation could release a never-run task for a member absent from the snapshot.
  // - Minimal failing input: one stale provider-list reply which still carries the group summary.
  // - Tier: unit (real runtime facade and directory read state; only transport mocked).
  it('does not report a stale directory snapshot as the current group membership', async () => {
    owner = 'stale-membership-owner';
    const staleConfig = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'stale-executor', providerId: 'openai' }] }, 'openai')!;
    io.catalogState.mockResolvedValueOnce({ views: [{
      id: 'openai', name: 'OpenAI', agents: ['codex'], models: { codex: [] }, connected: true,
      group: providerGroupSummaryForWire(staleConfig),
    }], stale: true, remainingMs: 60_000 });
    const groups = getProviderGroupRemoteGroups();

    expect(await groups.readGroup('stale-membership-owner', 'openai')).toBeUndefined();
  });
  // Test value
  // - Production entry: getProviderGroupRemoteGroups + createProviderGroupService.assignBeforeStart.
  // - Rule: a live online owner pick must assign and persist M even when the offline metadata
  //   target registry is full; a later offline task must still fail closed.
  // - Gap: the previous followup stopped at readGroup returning config and did not execute the
  //   service pick/binding/persist path.
  // - Minimal failing input: registry full, new O not in members, group has only M, O online pick returns M.
  // - Tier: integration-style unit (real runtime/client/service; IPC and service host deps controlled).
  it('assigns and persists M through the real service when the metadata registry is full', async () => {
    owner = 'continuity-service-local';
    io.invoke.mockReset();
    io.catalog.mockReset();
    io.status.mockReturnValue('online');
    const serviceOwner = 'continuity-service-owner';
    const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'service-executor', providerId: 'openai' }] }, 'openai')!;
    let livePicks = 0;
    io.invoke.mockImplementation(async (device: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:provider:list') {
        return invokeProviderMetadataContinuity(device, channel, args, async () => ({ ok: true, result: {
          providers: [{ id: 'openai', name: 'OpenAI', agents: ['codex'], models: { codex: [] },
            connected: true, remoteInvocationEnabled: true, group: providerGroupSummaryForWire(config) }],
        } }));
      }
      if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: string }).action === 'pick') {
        if (io.status() === 'offline') throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
        livePicks += 1;
        return { ok: true, result: { kind: 'member', member: config.members[0], label: 'M' } };
      }
      return { ok: true, result: {} };
    });
    for (let i = 0; i < 1100; i += 1) captureProviderMetadataContinuityScope(`service-target-${i}`);
    io.catalog.mockImplementationOnce(readDeviceProviderViews);
    const groups = getProviderGroupRemoteGroups();
    const bindings = new Map<string, ProviderGroupBinding>();
    const persistRoute = vi.fn(async () => undefined);
    const row = { agentKind: 'codex' as const, model: 'model', providerId: 'openai',
      agentDeviceId: serviceOwner, remoteHostId: null, sdkSessionId: null };
    const directory = {
      resolveMembers: async () => [], listCandidates: async () => [], readDeviceCatalog: async () => [],
      probe: async () => 'offline' as const, memberLabel: (member: { label?: string; key: string }) => member.label ?? member.key,
      invalidate: vi.fn(),
    };
    const deps = {
      router: getProviderGroupRouter(), directory, readGroup: () => null, remote: groups, localDeviceId: () => 'C',
      readBinding: (sessionId: string) => bindings.get(sessionId) ?? null,
      writeBinding: vi.fn(async (sessionId: string, binding: { providerId: string; memberKey: string;
        groupDeviceId?: string | null } | null) => {
        if (binding) bindings.set(sessionId, { providerId: binding.providerId, memberKey: binding.memberKey,
          ...(binding.groupDeviceId ? { groupDeviceId: binding.groupDeviceId } : {}), at: 1 });
        else bindings.delete(sessionId);
      }),
      isReleased: () => false, markReleased: vi.fn(async () => undefined),
      readSessionRow: vi.fn(async () => row), resolveImplicitProvider: vi.fn(async () => 'openai'),
      persistRoute, hasAssistantHistory: vi.fn(async () => false), isFailoverEligible: vi.fn(async () => true),
      leaseRecovery: vi.fn(() => ({})), isLeaseCurrent: vi.fn(() => true), rearmContinue: vi.fn(() => 7),
      cancelContinue: vi.fn(), switchAgentLocation: vi.fn(async () => undefined), isTurnRunning: vi.fn(() => false),
      hasLiveSession: vi.fn(() => false), continueSession: vi.fn(async () => 'resumed' as const),
      fallback: vi.fn(), readResetAt: vi.fn(() => null), now: () => 1_000,
      log: { info: vi.fn(), warn: vi.fn() },
    } satisfies ProviderGroupServiceDeps;
    const service = createProviderGroupService(deps);
    const context = await service.assignBeforeStart({ sessionId: 'service-new', agentKind: 'codex', model: 'model' });
    expect(livePicks).toBe(1);
    expect(context?.route).toEqual({ agentDeviceId: 'service-executor', providerId: 'openai' });
    expect(bindings.get('service-new')).toMatchObject({ providerId: 'openai',
      memberKey: 'device:service-executor:openai', groupDeviceId: serviceOwner });
    expect(persistRoute).toHaveBeenCalledWith('service-new', { agentDeviceId: 'service-executor', providerId: 'openai' });
    expect(await groups.readSnapshotGroup!(serviceOwner, 'openai')).toBeNull();

    io.status.mockReturnValue('offline');
    expect(await service.assignBeforeStart({ sessionId: 'service-offline', agentKind: 'codex', model: 'model' })).toBeNull();
    expect(livePicks).toBe(1);
    expect(persistRoute).toHaveBeenCalledTimes(1);
  });
});

describe('provider group runtime quota account selection', () => {
  let sequence = 0;
  const usage = () => ({
    updatedAt: Date.now(), fiveHour: { utilization: 25, resetsAt: Date.now() / 1000 + 3600 },
    sevenDay: { utilization: 45, resetsAt: Date.now() / 1000 + 86400 },
  });

  function harness(providerId = 'anthropic-second', native = 'claude') {
    owner = `quota-owner-${++sequence}`;
    const localId = native === 'codex' ? 'openai-local' : 'anthropic-local';
    const provider = (id: string) => ({ id, connected: true, auth: { method: 'oauth', native } }) as ProviderView;
    io.local.mockResolvedValue([provider(localId)]);
    io.catalog.mockResolvedValue([provider(providerId)]);
    io.devices.mockResolvedValue({ devices: [{ deviceId: 'mini', name: 'mini', online: true,
      remoteControlEnabled: true, controlEnabled: true, isSelf: false, platform: 'darwin' }] });
    io.invoke.mockReset();
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' },
      { kind: 'device', agentDeviceId: 'mini', providerId }] }, localId)!;
    const read = () => getProviderGroupDirectory().resolveMembers(localId, config);
    return { read, config, localId };
  }

  // #9833, unit: run the owner runtime → directory → router with a remote
  // account-pool reply. Legacy aggregate quota cannot prove model availability.
  it.each(['healthy', 'exhausted', 'old-peer', 'wrong-model', 'owner-change'] as const)(
    'recovers remote model cooling only from a current matching pool reply (%s)', async (reply) => {
      const h = harness('anthropic');
      const model = 'claude-sonnet-5-5';
      h.config.members = h.config.members.slice(1);
      io.group.mockReturnValue(h.config);
      io.catalog.mockResolvedValue([{ id: 'anthropic', connected: true, agents: ['claude-code'],
        auth: { method: 'oauth', native: 'claude' },
        models: { 'claude-code': [{ id: model, name: model, efforts: [], defaultEffort: null }] },
        routing: { 'claude-code': {} },
      } as unknown as ProviderView]);
      let preSend!: () => void;
      io.invoke.mockImplementation(async (_device, channel, args, options) => {
        expect(channel).toBe('maker:subscription-pool:quota');
        if (args.length === 1 || reply === 'old-peer')
          return { ok: true, result: { providerId: 'anthropic', pooled: true, usage: { claudeUsage: usage() } } };
        preSend = options.preSend;
        preSend();
        if (reply === 'owner-change') owner = 'changed-during-model-read';
        return { ok: true, result: { providerId: 'anthropic', model: reply === 'wrong-model' ? 'opus' : model,
          available: reply !== 'exhausted' } };
      });
      const router = getProviderGroupOwnerScope().router;
      const member = h.config.members[0];
      const until = Date.now() + 1_800_000;
      router.markCooling(h.localId, member.key, until, model);
      const pick = await router.pick({ providerId: h.localId, model, agentKind: 'claude-code' });
      expect(pick.kind).toBe(reply === 'healthy' ? 'member' : 'unavailable');
      expect(router.coolingUntil(h.localId, member.key, model)).toBe(reply === 'healthy' ? null : until);
      expect(io.invoke.mock.calls.filter(([, , args]) => args.length === 2)).toHaveLength(1);
      if (reply === 'owner-change') expect(() => preSend()).toThrow('provider group account changed');
      if (reply === 'healthy') {
        expect((await router.pick({ providerId: h.localId, model, agentKind: 'claude-code' })).kind).toBe('member');
        expect(io.invoke.mock.calls.filter(([, , args]) => args.length === 2)).toHaveLength(1);
      }
    },
  );

  // Unit: a new controller must keep the existing provider usable when an old
  // host explicitly rejects the new pool channel; named-account echo tests do
  // not cover that capability failure and fallback across both quota sources.
  it.each(['claude', 'codex'])('uses legacy %s quota when an old host rejects pool queries', async (native) => {
    const providerId = native === 'claude' ? 'anthropic' : 'openai';
    const h = harness(providerId, native);
    const bucket = { updatedAt: Date.now(), primary: { usedPercent: 12, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 } };
    io.invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:subscription-pool:quota')
        return { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'old host' } };
      return { ok: true, result: channel === 'maker:usage:claude-subscription'
        ? usage() : channel === 'maker:usage:codex-rate-limits' ? { rateLimits: bucket } : bucket };
    });
    const member = (await h.read())[1];
    expect(member.state).toBe('ok');
    if (native === 'claude') expect(member.claudeUsage?.fiveHour?.utilization).toBe(25);
    else expect(member.codexUsage?.appServerBuckets?.__default__?.primary?.usedPercent).toBe(12);
    await h.read();
    expect(io.invoke.mock.calls.filter(([, channel]) => channel === 'maker:subscription-pool:quota')).toHaveLength(1);
  });

  // Unit, pause report: invalidating the visible directory used to leave the
  // separate 30-second pool cache alive. The real change event must change quota.
  it.each(['local', 'remote'])('drops pool quota caches on %s account changes', async source => {
    const h = harness('anthropic', 'claude');
    let percent = 100;
    io.invoke.mockImplementation(async () => ({ ok: true, result: { providerId: 'anthropic', pooled: true,
      usage: { claudeUsage: { ...usage(), fiveHour: { utilization: percent, resetsAt: Date.now() / 1000 + 3600 } } } } }));
    expect((await h.read())[1].claudeUsage?.fiveHour?.utilization).toBe(100);
    percent = 10;
    if (source === 'local') io.localAccountPush!();
    else io.accountPush!('mini', 'subscription-accounts:changed');
    expect((await h.read())[1].claudeUsage?.fiveHour?.utilization).toBe(10);
  });

  // PR review: pooled native quota must survive both remote parsing and source merging for bridge engines.
  it('uses remote pool buckets for Pi and Claude Code while retaining model-specific capacity', async () => {
    const h = harness('openai', 'codex');
    const bucket = (limitName: string, usedPercent: number) => ({ limitName, updatedAt: Date.now(),
      primary: { usedPercent, windowMinutes: 300, resetsAt: Date.now() / 1000 + 7200 } });
    io.invoke.mockImplementation(async (_device, channel) => {
      if (channel !== 'maker:subscription-pool:quota') throw new Error('Unexpected legacy quota fallback');
      return { ok: true, result: { providerId: 'openai', pooled: true, usage: { codexUsage: {
        nativeAccountPool: true, webSnapshot: null,
        appServerBuckets: { codex: bucket('Codex', 100), special: bucket('special-model', 20) },
      } } } };
    });
    const resolved = await h.read();
    expect(resolved[1].codexUsage?.nativeAccountPool).toBe(true);
    for (const kind of ['pi', 'claude-code']) {
      // The native bucket still describes the full plan window, but the pool can spend credits.
      expect(providerGroupMemberUsageState(resolved[1], 'chatgpt/gpt-6', Date.now(), kind))
        .toMatchObject({ limited: false, quota: { usedPercent: 100 } });
      expect(providerGroupMemberUsageState(resolved[1], 'chatgpt/special-model', Date.now(), kind).limited).toBe(false);
    }
    expect(io.invoke).toHaveBeenCalledTimes(1);
  });

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

  // Unit: real runtime/directory reads must select each OpenAI connection, including legacy peers.
  // Claude's channel/echo cases cannot detect wrong arguments or accidental default-account reuse here.
  it.each([
    ['openai-second', 'openai-second', true], ['openai-second', undefined, false],
    ['openai-second', 'openai', false], ['openai', undefined, true],
  ])('reads OpenAI member accounts and rejects unscoped named-account replies (%s, %s)', async (id, echo, accepted) => {
    const h = harness(id, 'codex');
    const raw = { updatedAt: Date.now(), primary: { usedPercent: 30, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 } };
    const local = vi.fn(async () => raw);
    const localLimits = vi.fn(async () => ({ rateLimits: raw }));
    setProviderGroupCodexUsageReader(local, localLimits);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...(channel === 'maker:usage:codex-rate-limits' ? { rateLimits: raw } : raw),
      ...(echo ? { providerId: echo } : {}),
    } }));
    const resolved = await h.read();
    expect(local).toHaveBeenCalledExactlyOnceWith('openai-local');
    expect(localLimits).toHaveBeenCalledExactlyOnceWith('openai-local');
    expect(io.invoke).toHaveBeenCalledWith('mini', 'maker:usage:account', ['codex', id], { preSend: expect.any(Function) });
    expect(io.invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', [id], { preSend: expect.any(Function) });
    expect(resolved[0].codexUsage?.appServerBuckets?.__default__?.primary?.usedPercent).toBe(30);
    expect(resolved[1].codexUsage !== null).toBe(accepted);
    await h.read();
    // Built-in OpenAI probes account-pool support once, shared by its two quota sources.
    expect(io.invoke).toHaveBeenCalledTimes(id === 'openai' ? 3 : 2);
    expect(local).toHaveBeenCalledTimes(1);
    expect(localLimits).toHaveBeenCalledTimes(1);
  });

  it('discards OpenAI replies and blocks outgoing requests after an owner change', async () => {
    const h = harness('openai-second', 'codex');
    let preSend!: () => void;
    io.invoke.mockImplementation(async (_device, _channel, _args, options) => {
      preSend = options.preSend;
      preSend();
      owner = 'next-openai-owner';
      return { ok: true, result: { providerId: 'openai-second', updatedAt: Date.now(), primary: { usedPercent: 100 } } };
    });
    expect((await h.read())[1].codexUsage).toBeNull();
    expect(() => preSend()).toThrow('provider group account changed');
  });

  it.each([true, false])('keeps the available OpenAI quota source when the other channel is unsupported (native=%s)', async (native) => {
    const h = harness('openai-second', 'codex');
    const raw = { updatedAt: Date.now(), primary: { usedPercent: 45 } };
    io.invoke.mockImplementation(async (_device, channel) => {
      if ((channel === 'maker:usage:codex-rate-limits') !== native) return { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } };
      return { ok: true, result: { providerId: 'openai-second', ...(native ? { rateLimits: raw } : raw) } };
    });
    const resolved = await h.read();
    expect(resolved[1].codexUsage?.appServerBuckets?.__default__?.primary?.usedPercent).toBe(45);
  });

  // Unit: real runtime/directory quota eligibility must retain a completed source after the other times out.
  // P1 regression: immediate unsupported-channel cases miss a fast exhausted quota plus a pending sibling read.
  // Minimal input: native or WHAM at 100%, the other source deferred beyond 1.5s; cover local and same-account peers.
  // Standalone runtime.test.ts: 1.51s Vitest / 3.21s command wall time (including quick-pick regressions below).
  it.each([true, false])('keeps completed OpenAI quota while the other source is pending and merges its late result (native=%s)', async (native) => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const startedAt = Date.now();
    const quota = (usedPercent: number) => ({
      updatedAt: Date.now(), primary: { usedPercent, windowMinutes: 300, resetsAt: startedAt / 1000 + 3600 },
    });
    const completed = native ? { rateLimits: quota(100) } : { source: 'openai-web', ...quota(100) };
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { complete = resolve; });
    const account = vi.fn(async () => native ? pending : completed);
    const limits = vi.fn(async () => native ? completed : pending);
    setProviderGroupCodexUsageReader(account, limits);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...await (channel === 'maker:usage:codex-rate-limits' ? limits() : account()) as object,
      providerId: 'openai-second',
    } }));

    const fastKind = native ? 'codex' : 'pi';
    const slowKind = native ? 'pi' : 'codex';
    const firstRead = h.read();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    for (const member of await firstRead) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind))
        .toMatchObject({ limited: true, urgency: 0 });
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), slowKind).urgency).toBeNull();
    }
    const secondRead = h.read();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    for (const member of await secondRead) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind).limited).toBe(true);
    }
    expect(account).toHaveBeenCalledTimes(2);
    expect(limits).toHaveBeenCalledTimes(2);
    expect(io.invoke).toHaveBeenCalledTimes(2);

    const completedAt = Date.now();
    complete(native ? { source: 'openai-web', ...quota(25) } : { rateLimits: quota(25) });
    await vi.advanceTimersByTimeAsync(0);
    for (const member of await h.read()) {
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), fastKind).limited).toBe(true);
      expect(providerGroupMemberUsageState(member, 'gpt-5.3-codex', Date.now(), slowKind))
        .toMatchObject({ limited: false, urgency: expect.any(Number) });
      expect(member.codexUsage?.appServerBuckets?.__default__?.updatedAt).toBe(native ? startedAt : completedAt);
      expect(member.codexUsage?.webSnapshot?.updatedAt).toBe(native ? completedAt : startedAt);
    }
    expect(io.invoke).toHaveBeenCalledTimes(2);
    getProviderGroupDirectory().invalidate();
    await h.read();
    expect(io.invoke).toHaveBeenCalledTimes(4);
  });

  // Unit / PR #6562 P1: runtime → directory → router must retain quota at the outer quick-pick deadline.
  // Existing source-timeout cases start with an immediate catalog and never cross that deadline.
  // Minimal input: the first member's catalog takes 2s, one quota is 100%, its sibling never returns;
  // the second member is usable with unknown quota. Both source directions must pick the second at 3s.
  it.each([true, false])('avoids an exhausted member at the quick-pick deadline after a slow catalog (native=%s)', async (native) => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const model = 'gpt-5.3-codex';
    const provider = (id: string) => ({
      id, connected: true, auth: { method: 'oauth', native: 'codex' }, agents: ['codex', 'pi'],
      models: Object.fromEntries(['codex', 'pi'].map((agent) => [agent,
        [{ id: model, name: model, efforts: [], defaultEffort: null }]])), routing: { codex: {}, pi: {} },
    }) as unknown as ProviderView;
    io.local.mockResolvedValue([provider(h.localId)]);
    io.catalog.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve([provider('openai-second')]), 2_000);
    }));
    h.config.strategy = 'order';
    h.config.members.reverse();
    io.group.mockReturnValue(h.config);
    setProviderGroupCodexUsageReader(async () => null, async () => null);
    const raw = { updatedAt: Date.now(), primary: {
      usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600,
    } };
    io.invoke.mockImplementation(async (_device, channel) => {
      if ((channel === 'maker:usage:codex-rate-limits') !== native) return new Promise(() => {});
      return { ok: true, result: { providerId: 'openai-second',
        ...(native ? { rateLimits: raw } : { source: 'openai-web', ...raw }) } };
    });
    const picked = getProviderGroupRouter().pick({ providerId: h.localId, model, agentKind: native ? 'codex' : 'pi' });
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS);
    const result = await picked;
    expect(result).toMatchObject({ kind: 'member', member: { key: 'local' } });
    if (result.kind === 'member') {
      expect(providerGroupMemberUsageState(result.resolved[0], model, Date.now(), native ? 'codex' : 'pi'))
        .toMatchObject({ limited: true, urgency: 0 });
    }
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
  });

  it('discards completed OpenAI quota if the owner changes while its sibling source is pending', async () => {
    vi.useFakeTimers();
    const h = harness('openai-second', 'codex');
    const account = { source: 'openai-web', updatedAt: Date.now(), primary: { usedPercent: 100 } };
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { complete = resolve; });
    setProviderGroupCodexUsageReader(async () => account, () => pending);
    io.invoke.mockImplementation(async (_device, channel) => ({ ok: true, result: {
      ...await (channel === 'maker:usage:account' ? account : pending) as object,
      providerId: 'openai-second',
    } }));
    const read = h.read();
    await vi.advanceTimersByTimeAsync(0);
    owner = 'owner-after-partial-openai-read';
    complete({ rateLimits: { primary: { usedPercent: 25 } } });
    for (const member of await read) expect(member.codexUsage).toBeNull();
  });
});
