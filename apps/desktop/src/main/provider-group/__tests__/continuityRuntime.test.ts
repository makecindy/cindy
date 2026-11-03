/** Unit integration: real O preparation and M admission wiring; only local I/O is replaced.
 * Bug/rule: an old peer must never receive the new op, and C must not choose Fast policy.
 * Gap: pure routing tests cannot verify capability negotiation or Main permission epochs.
 * Minimal input: O prepares one route, then C starts one different task on M. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_AGENT_CHANNEL } from '@cindy/device-link';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';

const io = vi.hoisted(() => ({
  owner: 'account', realm: 'realm', epoch: 0, allowed: true, supported: true,
  group: undefined as unknown, changed: undefined as undefined | ((group: string) => void),
  invoke: vi.fn(), receive: vi.fn(async () => {}), received: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => io.owner }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => io.realm }));
vi.mock('../../device-link/index.js', () => ({ getRemoteLinkCloseEpoch: () => 0,
  getSelfDeviceId: () => 'M', remoteBackgroundInvoke: io.invoke }));
vi.mock('../../device-link/providerMetadataContinuity.js', () => ({ captureProviderMetadataContinuityScope: () => {
  const owner = io.owner, realm = io.realm; return () => owner === io.owner && realm === io.realm;
} }));
vi.mock('../managementScope.js', () => ({ captureProviderManagementScope: () => {
  const owner = io.owner; return () => { if (owner !== io.owner) throw new Error('account changed'); };
} }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: () => io.allowed, remoteProviderAccessEpoch: () => String(io.epoch),
  onRemoteProviderAccessChanged: () => () => {},
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({
  listProviders: async () => [{ id: 'openai', connected: true, source: 'user',
    models: { codex: [{ id: 'model', mode: 'chat' }] } }],
}) }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({
  providers: [{ id: 'openai', auth: { method: 'oauth', native: 'codex' } }],
}) }));
vi.mock('../store.js', () => ({ readProviderGroup: () => io.group,
  onProviderGroupChanged: (listener: (group: string) => void) => { io.changed = listener; return () => {}; } }));
vi.mock('../fastPolicyStore.js', () => ({ groupFastPolicyStore: { received: io.received, receive: io.receive } }));
const { createGroupContinuityRuntime } = await import('../continuityRuntime.js');

function fixture() {
  const runtime = createGroupContinuityRuntime(async () => new Map([['openai', 2]]));
  io.invoke.mockImplementation(async (_target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
    options?.preSend?.();
    if (channel === REMOTE_AGENT_CHANNEL) return { ok: true, result: { version: 1,
      agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024,
      maxPayloadBytes: 2048, ...(io.supported ? { groupContinuity: true } : {}) } };
    return { ok: true, result: await runtime.handle('O', args[0]) };
  });
  const member = normalizeProviderGroupConfig(io.group, 'openai')!.members[0];
  const prepare = () => runtime.prepare('C', { action: 'pick', providerId: 'openai', agentKind: 'codex',
    model: 'model', sessionId: 'initial', exclude: [] }, member);
  return { runtime, prepare };
}
beforeEach(() => {
  vi.clearAllMocks(); io.owner = 'account'; io.realm = 'realm'; io.epoch = 0; io.allowed = true; io.supported = true;
  io.group = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
    members: [{ kind: 'device', agentDeviceId: 'M', providerId: 'openai' }] }, 'openai');
  io.received.mockReturnValue({ revision: 7, allowFast: false });
});

describe('group continuity Main wiring', () => {
  it('binds the policy received from O to a distinct C task, with live M provider/model/load checks', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant?.remainingMs).toBeGreaterThan(0);
    const request = { action: 'continuity-admit', id: grant!.id, ownerDeviceId: 'O', sessionId: 'new-task' };
    expect(await f.runtime.handle('C', request)).toMatchObject({ id: grant!.id, running: 2 });
    expect(io.received).toHaveBeenCalledWith('O', 'openai');
    expect(io.receive).toHaveBeenCalledExactlyOnceWith('O', { group: 'openai', revision: 7, allowFast: false,
      binding: { sessionId: 'new-task', controllerDeviceId: 'C' } }, 'M', expect.any(Function));
    io.received.mockReturnValue(undefined);
    await expect(f.runtime.handle('C', { ...request, sessionId: 'without-policy' })).rejects.toThrow('ACCESS_REVOKED');
  });
  it('does not send preparation to legacy M or delay every later online pick on capability negotiation', async () => {
    io.supported = false; const f = fixture();
    expect(await f.prepare()).toBeUndefined(); expect(await f.prepare()).toBeUndefined();
    expect(io.invoke).toHaveBeenCalledTimes(1);
    expect(io.invoke.mock.calls[0][1]).toBe(REMOTE_AGENT_CHANNEL);
  });
  it('revokes acknowledged contexts after a group configuration change', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant).toBeDefined();
    io.group = { ...(io.group as object), autoSwitch: false }; io.changed!('openai');
    await Promise.resolve();
    expect(io.invoke.mock.calls.some(call => call[2][0].action === 'continuity-revoke')).toBe(true);
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
  });
  it('does not resurrect a context after the local provider is disabled and enabled again', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant).toBeDefined();
    io.allowed = false; io.epoch++; io.allowed = true; io.epoch++;
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    expect(io.receive).not.toHaveBeenCalled();
  });
});
