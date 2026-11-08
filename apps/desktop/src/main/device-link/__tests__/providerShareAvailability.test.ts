import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer, type ProviderShareOwned } from '@cindy/device-link';
const f = vi.hoisted(() => ({
  connected: true, scope: 'owner', self: 'owner-pc', remote: true, budget: false,
  request: vi.fn(), remember: vi.fn(), reconcile: vi.fn(), apply: vi.fn(), invalidate: vi.fn(),
  members: [] as any[], leases: [] as any[],
}));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => f.self }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://fake.invalid' }));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: (...args: any[]) => f.request(...args) }));
vi.mock('../../provider-group/managementScope.js', () => ({ captureProviderManagementScope: () => {
  const scope = f.scope; return () => { if (scope !== f.scope) throw new Error('account changed'); };
} }));
vi.mock('../providerShareApi.js', () => ({ providerShareOwnerKey: () => f.scope }));
vi.mock('../providerShareAvailabilityPolicy.js', () => ({ withAvailabilityPolicyLock: (work: () => unknown) => work(), rememberAvailabilityShare: (...args: any[]) => f.remember(...args) }));
vi.mock('../providerShareAvailabilityGuests.js', () => ({ knownStandbyGuests: () => [], reconcileStandbyGuest: (...args: any[]) => f.reconcile(...args) }));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: () => ({ allowFast: false }) }));
vi.mock('../../provider-group/fastPolicyStore.js', () => ({ groupFastPolicyStore: { outgoing: () => ({ group: { revision: 7, allowFast: false } }) } }));
vi.mock('../../provider-group/runtime.js', () => ({ getProviderGroupDirectory: () => ({ resolveMembers: async () => f.members }) }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: async () => [{ id: 'group', connected: f.connected, models: { codex: [{ id: 'allowed' }] } }] }) }));
vi.mock('../remoteModelAccess.js', () => ({ remoteModelAccess: { allowsDelegatedExecution: (_p: string, model: string) => !f.budget && model === 'allowed' } }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: f.remote, disabledControlDeviceIds: [], revokedControllers: [] }) }));
vi.mock('../providerShareCrossRegion.js', () => ({ isCrossRegionShare: () => false }));
vi.mock('../providerShareGuest.js', () => ({ findReceivedShare: () => ({ standbyOnline: true }) }));
vi.mock('../providerShareDelegatedAccess.js', () => ({ applyProviderShareDelegation: (...args: any[]) => f.apply(...args), delegatedProviderShareLeases: () => f.leases,
  invalidateProviderShareDelegation: (...args: any[]) => f.invalidate(...args) }));
import { publishShareAvailability, prepareShareAvailability, allocateShareAvailability, readShareAvailabilityCatalog, beginShareAvailabilityTurn } from '../providerShareAvailability.js';
const model = { id: 'allowed', name: 'Fake model', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' };
const owned = { shareId: 'share', hostDeviceId: 'owner-pc', providerId: 'group', members: [{ memberId: 'member', status: 'active', joinedAt: '2026-11-08T00:00:00Z' }] } as ProviderShareOwned;
beforeEach(() => {
  vi.clearAllMocks();
  f.connected = true; f.scope = 'owner'; f.self = 'owner-pc'; f.remote = true; f.budget = false; f.leases = [];
  f.members = [{ member: { kind: 'device', agentDeviceId: 'standby', providerId: 'local', limit: 2 }, state: 'ok', view: { connected: true, models: { codex: [model, { ...model, id: 'hidden', disabled: true }] } } }];
  f.request.mockImplementation(async (path: string) => path.endsWith('/policy') ? { revision: 5, executors: [] } : {});
});
describe('standby client production entry points (all identities/providers are local fakes)', () => {
  it('keeps a turn-bound completion receipt after revocation, without crossing account scope', async () => {
    const peer = providerShareGuestPeer('share', 'member', 'guest');
    f.leases = [{ peer, sessionId: 'task', lease: { availability: true, generation: 'assignment-a' } }];
    const complete = await beginShareAvailabilityTurn(peer, 'task', 'turn-a');
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
  it('publishes local provider mapping and exact model permission without credentials', async () => {
    await publishShareAvailability([owned]);
    const body = f.request.mock.calls.find(([path]) => path.endsWith('/publish'))![1].body.policy;
    expect(body).toMatchObject({ revision: 5, allowFast: false, fastRevision: 7,
      executors: [{ deviceId: 'standby', providerId: 'local', limit: 2, models: [{ ...model, kind: 'codex' }] }],
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
