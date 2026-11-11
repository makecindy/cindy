import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer, type ProviderShareOwned } from '@cindy/device-link';
const f = vi.hoisted(() => ({
  endpoint: 'https://fake.invalid', usage: null as any, connected: true, scope: 'owner', self: 'owner-pc', remote: true, budget: false,
  invoke: vi.fn(), netFetch: vi.fn(), log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, request: vi.fn(), remember: vi.fn(), reconcile: vi.fn(), apply: vi.fn(), invalidate: vi.fn(),
  members: [] as any[], leases: [] as any[],
}));
vi.mock('electron', () => ({ net: { fetch: (...args: any[]) => f.netFetch(...args) } }));
vi.mock('../../i18n.desktop.js', () => ({ getResolvedMainLocale: () => 'zh-CN' }));
vi.mock('../../logger.js', () => ({ createLogger: () => f.log }));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => f.self, getAccessToken: () => null }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => f.endpoint }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: (...args: any[]) => f.request(...args) }));
vi.mock('../../provider-group/managementScope.js', () => ({ captureProviderManagementScope: () => {
  const scope = f.scope; return () => { if (scope !== f.scope) throw new Error('account changed'); };
} }));
vi.mock('../providerShareApi.js', () => ({ providerShareOwnerKey: () => f.scope }));
vi.mock('../providerShareAvailabilityPolicy.js', () => ({ withAvailabilityPolicyLock: (work: () => unknown) => work(), rememberAvailabilityShare: (...args: any[]) => f.remember(...args) }));
vi.mock('../providerShareAvailabilityGuests.js', () => ({ knownStandbyGuests: () => [], reconcileStandbyGuest: (...args: any[]) => f.reconcile(...args) }));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: () => ({ allowFast: false }) }));
vi.mock('../../provider-group/fastPolicyStore.js', () => ({ groupFastPolicyStore: { receive: async () => {}, requireOrigin: () => {}, outgoing: () => ({ group: { revision: 7, allowFast: false } }) } }));
vi.mock('../../provider-group/runtime.js', () => ({ getProviderGroupDirectory: () => ({ resolveMembers: async () => f.members }) }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: async () => [{ id: 'group', connected: f.connected, models: { codex: [{ id: 'allowed' }] } }] }) }));
vi.mock('../remoteModelAccess.js', () => ({ remoteModelAccess: { allowsDelegatedExecution: (_p: string, model: string) => !f.budget && model === 'allowed' } }));
vi.mock('../settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: f.remote, disabledControlDeviceIds: [], revokedControllers: [] }) }));
vi.mock('../providerShareCrossRegion.js', () => ({ isCrossRegionShare: () => false }));
vi.mock('../providerShareGuest.js', () => ({ findReceivedShare: () => ({ standbyOnline: true }) }));
vi.mock('../providerShareDelegatedAccess.js', () => ({ applyProviderShareDelegation: (...args: any[]) => f.apply(...args), delegatedProviderShareLeases: () => f.leases,
  invalidateProviderShareDelegation: (...args: any[]) => f.invalidate(...args) }));
vi.mock('../../maker-host/subscription-fast-policy.js', () => ({ notifySubscriptionFastPolicyChanged: async () => {} }));
vi.mock('../providerShareUsageStore.js', async importOriginal => ({ ...await importOriginal<object>(), getProviderShareUsageStore: () => f.usage }));
import { createProviderShareUsageStore } from '../providerShareUsageStore.js';
import { publishShareAvailability, prepareShareAvailability, allocateShareAvailability, readShareAvailabilityCatalog, beginShareAvailabilityTurn } from '../providerShareAvailability.js';
import { readDeviceProviderCatalog, readRemoteProviderRoute } from '../../remote-agent/controller/deviceCatalog.js';
import { remoteAgentProviders } from '../../../renderer/components/new-chat/unifiedModelSelection.js';
vi.mock('../../device-link', () => ({ remoteBackgroundInvoke: (...args: unknown[]) => f.invoke(...args) }));
const realApi = await vi.importActual<typeof import('../../serverApiClient.desktop.js')>('../../serverApiClient.desktop.js');
const realDelegation = await vi.importActual<typeof import('../providerShareDelegatedAccess.js')>('../providerShareDelegatedAccess.js');
let dir: string;
const model = { id: 'allowed', name: 'Fake model', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' };
const owned = { shareId: 'share', hostDeviceId: 'owner-pc', providerId: 'group', members: [{ memberId: 'member', status: 'active', joinedAt: '2026-11-08T00:00:00Z' }] } as ProviderShareOwned;
beforeEach(async () => {
  vi.clearAllMocks();
  realDelegation.clearProviderShareDelegations(); f.apply.mockReset(); f.reconcile.mockReset();
  f.endpoint = 'https://fake.invalid';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-availability-'));
  f.usage = createProviderShareUsageStore(path.join(dir, 'usage.json'));
  await f.usage.reconcileMemberGenerations('owner', 'owner-pc', [owned]);
  f.connected = true; f.scope = 'owner'; f.self = 'owner-pc'; f.remote = true; f.budget = false; f.leases = [];
  f.members = [{ member: { kind: 'device', agentDeviceId: 'standby', providerId: 'local', limit: 2 }, state: 'ok', view: { connected: true, models: { codex: [model, { ...model, id: 'hidden', disabled: true }] } } }];
  f.request.mockImplementation(async (path: string) => path.endsWith('/policy') ? { revision: 5, executors: [] } : {});
});
afterEach(() => { realDelegation.clearProviderShareDelegations(); fs.rmSync(dir, { recursive: true, force: true }); });
describe('standby client production entry points (all identities/providers are local fakes)', () => {
  // Unit: 4505241076; the previous mocked API bypassed redaction and hid the
  // lost NOT_FOUND code. Exercise preparation through the real HTTP wrapper.
  it('cleans revoked standby grants through a redacted real HTTP error', async () => {
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    f.leases = [{ peer, sessionId: 'task', lease: { availability: true, nonce: 'nonce' } }];
    f.netFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'private member details' } }), { status: 404 }));
    f.request.mockImplementation(realApi.serverApiFetch);
    await expect(prepareShareAvailability(peer)).rejects.toMatchObject({ code: 'NOT_FOUND', message: '请求失败 (404)' });
    expect(f.invalidate).toHaveBeenCalledWith(peer, 'task', 'nonce');
    expect(f.reconcile).toHaveBeenCalledWith(peer, null);
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain('private member details');
  });
  it('does not clean the new account when an old-scope NOT_FOUND arrives late', async () => {
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    f.leases = [{ peer, sessionId: 'task', lease: { availability: true, nonce: 'new-account' } }];
    f.netFetch.mockImplementation(async () => {
      f.scope = 'new-account';
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    });
    f.request.mockImplementation(realApi.serverApiFetch);
    await expect(prepareShareAvailability(peer)).rejects.toThrow('account changed');
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });
  it.each([false, true])('captures completion before admission and retains it after revocation (lost response=%s)', async lost => {
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    f.leases = [{ peer, sessionId: 'task', lease: { availability: true, generation: 'assignment-a' } }];
    let complete: (() => Promise<void>) | undefined;
    f.request.mockImplementation(async (path: string) => {
      expect(complete).toBeTypeOf('function');
      if (lost && path.endsWith('/accept')) throw new Error('admission response lost');
      return {};
    });
    const admission = beginShareAvailabilityTurn(peer, 'task', 'turn-a', receipt => { complete = receipt; });
    if (lost) await expect(admission).rejects.toThrow('admission response lost');
    else await admission;
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/accept$/), expect.objectContaining({
      body: { memberId: 'member', guestDeviceId: 'guest', sessionId: 'task', generation: 'assignment-a', executionId: 'turn-a' },
    }));
    f.leases = [];
    await complete!();
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/complete$/), expect.objectContaining({
      body: { sessionId: 'task', generation: 'assignment-a', executionId: 'turn-a' },
    }));
    const count = f.request.mock.calls.length;
    f.scope = 'other-account';
    await expect(complete!()).rejects.toThrow('account changed');
    expect(f.request).toHaveBeenCalledTimes(count);
  });
  // Unit: 4505570024. Real preparation + delegation; switch after the first
  // installed assignment or during cleanup, beyond the HTTP wrapper's guard.
  it.each(['between-grants', 'cleanup', 'approval-endpoint', 'unchanged'] as const)('keeps preparation grants in their initiating scope at %s', async boundary => {
    f.self = 'standby';
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    const row = { shareId: 'share', memberId: 'member', guestDeviceId: 'guest', executorDeviceId: 'standby',
      providerId: 'local', kind: 'codex', model: 'allowed', generation: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60000 };
    f.request.mockResolvedValue({ ownerDeviceId: 'owner-pc', joinedAt: 1, groupProviderId: 'group', revision: 7,
      allowFast: false, assignments: [{ ...row, sessionId: 'first' }, { ...row, sessionId: 'second' }] });
    const switchAccount = () => { f.scope = 'account-b'; realDelegation.clearProviderShareDelegations(); };
    if (boundary === 'cleanup') f.reconcile.mockImplementationOnce(switchAccount);
    f.apply.mockImplementation(async (owner, grant, approve, availability) => {
      if (boundary === 'approval-endpoint') f.endpoint = 'https://other.invalid';
      const result = await realDelegation.applyProviderShareDelegation(owner, grant, approve, availability);
      if (boundary === 'between-grants' && grant.sessionId === 'first') switchAccount();
      return result;
    });
    if (boundary === 'unchanged') {
      await prepareShareAvailability(peer);
      expect(realDelegation.delegatedProviderShareLeases().map(item => [item.sessionId, item.lease.ownerScope]))
        .toEqual([['first', 'owner'], ['second', 'owner']]);
    } else {
      await expect(prepareShareAvailability(peer)).rejects.toThrow();
      expect(realDelegation.delegatedProviderShareLeases()).toEqual([]);
    }
  });
  // Unit: 4505570030. Production durable ledger and publisher, real pending
  // local cleanup and executor ACKs, rather than a mocked readiness boolean.
  it('publishes a reapproved member only after local and executor cleanup', async () => {
    const route = { ownerScope: 'owner', ownerDeviceId: 'owner-pc', shareId: 'share', memberId: 'member',
      guestDeviceId: 'guest', sessionId: 'old-task', executorDeviceId: 'standby', providerId: 'local',
      model: 'allowed', agentKind: 'codex', generation: '11111111-1111-4111-8111-111111111111',
      executorProviderId: 'local', memberKey: 'device:standby', memberJoinedAt: owned.members[0].joinedAt, expiresAt: Date.now() + 60000 };
    await f.usage.registerDirectReceiptRoute(route);
    const updated = { ...owned, members: [{ ...owned.members[0], joinedAt: '2026-11-08T01:00:00Z' }] };
    const [pending] = await f.usage.reconcileMemberGenerations('owner', 'owner-pc', [updated]);
    f.usage = createProviderShareUsageStore(path.join(dir, 'usage.json'));
    const published = async () => {
      f.request.mockClear(); await publishShareAvailability([updated]);
      return f.request.mock.calls.find(([url]) => url.endsWith('/publish'))![1].body.policy.members;
    };
    expect(await published()).toEqual([]);
    await f.usage.acknowledgeMemberCleanup(pending);
    expect(await published()).toEqual([]);
    await f.usage.acknowledgeDirectCleanup(f.usage.listPendingDirectCleanup('owner')[0]);
    expect(await published()).toEqual([{ memberId: 'member', joinedAt: Date.parse(updated.members[0].joinedAt), models: ['allowed'] }]);
  });
  // #9501 unit: publish the executor's effective window using the existing wire
  // field; prior coverage only had a default and missed advanced-settings overrides.
  it.each([undefined, 1_000_000])('publishes local provider mapping with source budget %s and exact permission', async (limit) => {
    f.members[0].view.models.codex[0] = { ...model, contextWindowOverride: limit };
    await publishShareAvailability([owned]);
    const body = f.request.mock.calls.find(([path]) => path.endsWith('/publish'))![1].body.policy;
    expect(body).toMatchObject({ revision: 5, allowFast: false, fastRevision: 7,
      executors: [{ deviceId: 'standby', providerId: 'local', limit: 2, models: [{ ...model, contextWindow: limit ?? model.contextWindow, kind: 'codex' }] }],
      members: [{ memberId: 'member', models: ['allowed'] }] });
    expect(f.remember).toHaveBeenCalledWith('share', 'group');
  });
  it('keeps healthy group executors and member restrictions when the owner provider is logged out', async () => {
    f.connected = false;
    await publishShareAvailability([owned]);
    const policy = f.request.mock.calls.find(([path]) => path.endsWith('/publish'))![1].body.policy;
    expect(policy.executors.map((row: any) => row.deviceId)).toEqual(['standby']);
    expect(policy.members[0].models).toEqual(['allowed']);
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/disable'))).toBe(false);
  });
  it('does not register third-party shares and denies unverifiable personal budgets', async () => {
    f.members.push({ ...f.members[0], member: { kind: 'share', agentDeviceId: 'foreign', providerId: 'foreign' } });
    f.budget = true;
    await publishShareAvailability([owned]);
    const policy = f.request.mock.calls.find(([path]) => path.endsWith('/publish'))![1].body.policy;
    expect(policy.executors).toHaveLength(1);
    expect(policy.members[0].models).toEqual([]);
  });
  it('rejects an account change before publishing', async () => {
    f.request.mockImplementation(async () => { f.scope = 'different-account'; return { revision: 5, executors: [] }; });
    await expect(publishShareAvailability([owned])).rejects.toThrow('account changed');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('preserves model selection metadata and validates cloud task identity', async () => {
    f.request.mockResolvedValue({ providerId: 'group', providerLabel: 'Fake', models: [{ ...model, kind: 'codex' }] });
    expect((await readShareAvailabilityCatalog('share')).providers[0].models.codex?.[0]).toEqual(model);
    f.request.mockResolvedValue({ shareId: 'other', sessionId: 'task', kind: 'codex', model: 'allowed', executorDeviceId: 'standby', generation: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60_000 });
    await expect(allocateShareAvailability('share', 'task', 'codex', 'allowed')).rejects.toThrow('Invalid');
  });
  // Production projection and consumers, with only HTTP/IPC transport replaced.
  // A populated cloud catalog must survive the existing remote permission filters.
  it.each(['menu', 'main', 'scheduled'] as const)('keeps authorized standby models usable by %s', async consumer => {
    f.request.mockImplementation(realApi.serverApiFetch);
    f.netFetch.mockResolvedValue(new Response(JSON.stringify({ providerId: 'group', providerLabel: 'Fake',
      models: [{ ...model, kind: 'codex' }] }), { status: 200 }));
    const catalog = await readShareAvailabilityCatalog('share');
    f.invoke.mockResolvedValue({ ok: true, result: JSON.parse(JSON.stringify(catalog)) });
    if (consumer === 'menu') {
      const views = remoteAgentProviders(catalog.providers);
      expect(views.map(view => view.id)).toEqual(['group']);
      expect(views[0].models.codex).toEqual([model]);
    } else if (consumer === 'main') {
      const { views } = await readDeviceProviderCatalog(f.invoke, 'share:share');
      expect(views.map(view => view.id)).toEqual(['group']);
      expect(views[0].models.codex).toEqual([model]);
    } else {
      const route = await readRemoteProviderRoute({ agentDeviceId: 'share:share', agentKind: 'codex', providerId: 'group', model: 'allowed' });
      expect(route.provider.id).toBe('group');
      expect(route.model).toEqual(model);
      await expect(readRemoteProviderRoute({ agentDeviceId: 'share:share', agentKind: 'codex', providerId: 'group', model: 'hidden' }))
        .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    }
  });
  it('binds only server-verified tasks to this executor and clears revoked cloud leases', async () => {
    f.self = 'standby';
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    const row = { shareId: 'share', memberId: 'member', guestDeviceId: 'guest', sessionId: 'task', executorDeviceId: 'standby', providerId: 'local', kind: 'codex', model: 'allowed', generation: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60000 };
    f.request.mockResolvedValue({ ownerDeviceId: 'owner-pc', joinedAt: 1, groupProviderId: 'group', revision: 7, allowFast: false, assignments: [row] });
    await prepareShareAvailability(peer);
    expect(f.apply).toHaveBeenCalledWith('owner-pc', expect.objectContaining({ providerId: 'local', model: 'allowed', sessionId: 'task' }), expect.any(Function), true);
    f.leases = [{ peer, sessionId: 'task', lease: { availability: true, nonce: 'nonce' } }];
    f.request.mockRejectedValue(Object.assign(new Error('removed'), { code: 'NOT_FOUND' }));
    await expect(prepareShareAvailability(peer)).rejects.toThrow('removed');
    expect(f.invalidate).toHaveBeenCalledWith(peer, 'task', 'nonce');
    expect(f.reconcile).toHaveBeenLastCalledWith(peer, null);
  });
});
