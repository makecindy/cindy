import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../../../shared/providerGroup.js';
import type { RemoteAgentHostDeps } from '../../remote-agent/host/runHost.js';
import type { ProviderShareUsageStore } from '../../device-link/providerShareUsageStore.js';
import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';
import { providerShareGuestPeer, type ProviderShareOwned, type RemoteAgentFastPolicy, type RemoteAgentRequest } from '@cindy/device-link';

const state = vi.hoisted(() => ({
  owner: 'test',
  config: null as ProviderGroupConfig | null,
  subscription: true,
  old: new Set<string>(),
  offline: new Set<string>(),
  broken: new Set<string>(),
  beforeCaps: undefined as undefined | (() => Promise<void>),
  calls: [] as Array<{ device: string; command: Record<string, any> }>,
  notify: vi.fn(async () => {}),
  self: 'self',
  direct: false,
  planDevice: 'one',
  approved: true,
  delegatedAllowed: true,
  modelChanged: undefined as (() => void) | undefined,
  shareOwner: 'test',
  shares: [] as ProviderShareOwned[],
  revoked: [] as string[],
  hostDeps: undefined as RemoteAgentHostDeps | undefined,
  usage: undefined as ProviderShareUsageStore | undefined,
  hostChanged: undefined as (() => void) | undefined,
  pair: null as null | { generation: string; expiresAt: number; ownerDeviceId: string; executorDeviceId: string },
  check: vi.fn(),
  failGrant: false,
  delegateCalls: [] as RemoteAgentRequest[],
}));
function ownedShareSnapshot(): readonly ProviderShareOwned[] | null {
  if (state.owner !== state.shareOwner) return null;
  return state.shares.map((share) => ({ ...share, members: state.approved ? share.members : [] }));
}
function ownedGuestAccess(peer: string) {
  if (peer !== providerShareGuestPeer('share', 'member', 'laptop')) return null;
  const share = ownedShareSnapshot()?.find((entry) => entry.shareId === 'share' && entry.hostDeviceId === 'self');
  const member = share?.members.find((entry) => entry.memberId === 'member' && entry.status === 'active');
  return share && member ? { shareId: share.shareId, memberId: member.memberId, providerId: share.providerId } : null;
}
vi.mock('../../authManager.js', () => ({ getDeviceId: () => 'one' }));
vi.mock('../../device-link/providerShareApi.js', () => ({
  providerShareOwnerKey: () => state.owner,
  checkProviderShareDelegation: (...args: unknown[]) => state.check(...args),
  grantProviderShareDelegation: async ({ executorDeviceId }: { executorDeviceId: string }) => {
    if (state.failGrant) throw Error('server unavailable');
    state.pair = { generation: randomUUID(), expiresAt: Date.now() + 30 * 60_000,
      ownerDeviceId: 'self', executorDeviceId };
    return state.pair;
  },
  // The server contract is one generation per G/M pair, not one per task.
  revokeProviderShareDelegation: async ({ generation }: { generation: string }) => {
    if (state.pair?.generation === generation) state.pair = null;
  },
}));
vi.mock('../../device-link/settings-store.js', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: state.revoked }),
  onDeviceLinkSettingChanged: () => () => {},
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../../device-link/providerShareHost.js', () => ({
  getProviderShareHostLoadedSnapshot: ownedShareSnapshot,
  ownedProviderShareGuestAccess: ownedGuestAccess,
  providerShareGuestAccess: ownedGuestAccess,
  verifyProviderShareMemberGeneration: async (member: { shareId: string; memberId: string; joinedAt: string }) => {
    const saved = ownedShareSnapshot()?.find((share) => share.shareId === member.shareId && share.hostDeviceId === 'self')
      ?.members.find((entry) => entry.memberId === member.memberId);
    if (!saved || saved.status !== 'active' || saved.joinedAt !== member.joinedAt) {
      throw Error('Provider share membership changed during grant');
    }
  },
  onProviderShareHostChanged: (callback: () => void) => { state.hostChanged = callback; return () => {}; },
}));
vi.mock('../../device-link/remoteModelAccess.js', () => ({
  remoteModelAccess: { allows: () => true, allowsDelegatedExecution: () => state.delegatedAllowed,
    subscribe: (callback: () => void) => { state.modelChanged = callback; return () => {}; } },
}));
vi.mock('../../device-link/providerShareUsageStore.js', async (original) => ({
  ...await original<typeof import('../../device-link/providerShareUsageStore.js')>(),
  installProviderShareUsageStore: () => state.usage!,
  getProviderShareUsageStore: () => state.usage,
}));
vi.mock('../../remote-agent/host/runHost.js', () => ({
  createRemoteAgentHost: (deps: RemoteAgentHostDeps) => { state.hostDeps = deps; return {
    dispose() {}, issueDirectGroupSwitchToken: () => randomUUID(),
  }; },
}));
vi.mock('../../remote-agent/controller/runClient.js', () => ({
  RemoteAgentRunClient: { caps: async () => ({ directGuestExecution: true, guestRelay: true }) },
}));
vi.mock('../../remote-agent/controller/service', () => ({ remoteAgentPollerFor: vi.fn() }));
vi.mock('../guestRelay.js', () => ({
  createProviderGroupGuestRelay: () => ({
    plan: async () => ({ kind: 'member', agentDeviceId: state.planDevice, providerId: 'openai',
      memberKey: `device:${state.planDevice}:openai`, sameAccount: true }),
    trackRun: () => ({ setRunning() {}, release() {} }),
    connect: (device: string) => {
      if (state.offline.has(device)) throw Error('executor offline');
      return { invoke: async ([request]: RemoteAgentRequest[]) => {
      state.delegateCalls.push(request);
      if (request.op === 'delegate') return delegation.applyProviderShareDelegation('self', request);
      throw Error(`Unexpected remote command: ${request.op}`);
    } }; },
  }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => state.owner, isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../../device-link/dispatch.js', () => ({ setRemoteAgentHandler() {} }));
vi.mock('../../device-link/providerShareReshare.js', () => ({ handleProviderShareReshare() {}, providerShareReshareAllows() {} }));
vi.mock('../reshareRuntime.js', () => ({ providerGroupReshare: {} }));
vi.mock('../runtime.js', () => ({ getProviderGroupOwnerScope: () => state.owner }));
vi.mock('../../remote-agent/host/limitsStore.js', () => ({ readRemoteAgentLimitsState: () => ({ value: {} }) }));
vi.mock('../../remote-agent/host/providerAccess', () => ({ createGuestProviderRouteBinder: () => vi.fn() }));
vi.mock('../../remote-agent/host/transcripts', () => ({}));
vi.mock('../../cindy-media/generatedImageStorage', () => ({}));
vi.mock('../../goal-host/usageLimit.js', () => ({}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({}));
vi.mock('../../maker-host/session-provider-store.js', () => ({ bindHostedSessionProvider() {} }));
vi.mock('../../maker-host/guest-provider-route-store.js', () => ({}));
vi.mock('../../usage/providerPartyUsageStore.js', () => ({
  flushProviderPartyUsage: async () => {}, currentProviderPartyUsageStore: () => ({}),
}));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fast-sync-'));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (file: string) => path.join(temporary, state.owner, file),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [
      { id: 'openai', auth: { method: state.subscription ? 'oauth' : 'apiKey', native: 'codex' } },
    ],
  }),
}));
vi.mock('../../maker-host/subscription-fast-policy.js', () => ({
  notifySubscriptionFastPolicyChanged: () => state.notify(),
}));
vi.mock('../store.js', () => ({
  readProviderGroup: () => state.config,
  listProviderGroups: () => (state.config ? { openai: state.config } : {}),
  onProviderGroupChanged: () => () => {},
}));
vi.mock('../../device-link/index.js', () => ({
  getSelfDeviceId: () => state.self,
  remoteBackgroundInvoke: async (
    device: string,
    _channel: string,
    args: Array<Record<string, any>>,
  ) => {
    const command = args[0];
    state.calls.push({ device, command });
    if (command.op === 'caps') await state.beforeCaps?.();
    if (state.broken.has(device)) throw Error('[LINK_NOT_OPEN] disconnected');
    if (state.offline.has(device))
      return { ok: false, error: { code: 'IPC_ERROR', message: 'offline' } };
    if (command.op === 'caps')
      return {
        ok: true,
        result: {
          version: 1,
          maxRuns: 10,
          uploadChunkBytes: 1024,
          maxPayloadBytes: 8192,
          ...(!state.old.has(device) ? { subscriptionFastPolicy: true } : {}),
        },
      };
    if (state.direct && command.op === 'fast-policy') {
      state.self = device;
      try { return { ok: true, result: await runtime.receiveGroupFastPolicy('self', command as RemoteAgentFastPolicy) }; }
      finally { state.self = 'self'; }
    }
    return { ok: true, result: { revision: command.revision, allowFast: command.allowFast } };
  },
}));
const runtime = await import('../fastPolicyRuntime.js');
const { groupFastPolicyStore, createGroupFastPolicyStore } = await import('../fastPolicyStore.js');
const delegation = await import('../../device-link/providerShareDelegatedAccess.js');
const { createProviderShareUsageStore } = await import('../../device-link/providerShareUsageStore.js');
const { installRemoteAgentHost, disposeRemoteAgentHost } = await import('../../remote-agent/host/service.js');
let sequence = 0;
beforeEach(() => {
  state.self = 'self';
  state.direct = false;
  state.planDevice = 'one';
  state.approved = true;
  state.delegatedAllowed = true;
  state.modelChanged = undefined;
  state.revoked = [];
  state.pair = null;
  state.failGrant = false;
  state.delegateCalls = [];
  state.usage = undefined;
  state.check.mockReset().mockImplementation(async ({ executorDeviceId }) =>
    state.pair?.executorDeviceId === executorDeviceId ? { active: true, ...state.pair } : { active: false });
  state.owner = `owner-${++sequence}`;
  state.shareOwner = state.owner;
  state.shares = [{ shareId: 'share', providerId: 'openai', providerLabel: 'OpenAI', hostDeviceId: 'self',
    createdAt: '2026-10-28T00:00:00.000Z', requests: [],
    members: [{ memberId: 'member', status: 'active', joinedAt: '2026-10-28T00:00:00.000Z',
      displayName: 'Guest', avatarUrl: null, region: 'global' }] }];
  state.subscription = true;
  state.calls = [];
  state.old.clear();
  state.offline.clear();
  state.broken.clear();
  state.beforeCaps = undefined;
  state.notify.mockReset().mockResolvedValue(undefined);
  state.config = {
    strategy: 'least',
    autoSwitch: true,
    allowFast: false,
    members: ['one', 'two'].map((device) => ({
      key: `device:${device}:openai`,
      kind: 'device',
      agentDeviceId: device,
      providerId: 'openai',
      limit: 10,
      weight: 1,
      paused: false,
    })),
  };
});
afterEach(async () => {
  disposeRemoteAgentHost();
  await state.usage?.flush();
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

const guestPeer = providerShareGuestPeer('share', 'member', 'laptop');
const directTask = (sessionId: string) => hostSessionIdFor(guestPeer, sessionId);
const usageFile = () => path.join(temporary, state.owner, 'usage.json');
async function installDirectHost() {
  state.direct = true;
  state.usage = createProviderShareUsageStore(usageFile());
  // Host snapshot preparation persists the membership baseline before admission.
  // Use the real ledger on initial install and restart; never bypass its cleanup fence.
  await state.usage.reconcileMemberGenerations(state.owner, 'self', ownedShareSnapshot()!);
  installRemoteAgentHost({ userDataDir: path.join(temporary, state.owner),
    getMaker: () => { throw Error('Allocation must not start an agent on O'); } });
}
const allocate = (sessionId: string) => state.hostDeps!.directGuestExecution!.allocate(guestPeer,
  { op: 'allocate', sessionId, agentKind: 'codex', model: 'gpt-5' });
function failAllocationAt(stage: 'Fast' | 'commit' | 'register') {
  if (stage === 'Fast') state.notify.mockRejectedValue(Error('native policy failed'));
  else vi.spyOn(state.usage!, stage === 'commit' ? 'commitDirectReceiptRoute' : 'registerDirectReceiptRoute')
    .mockRejectedValue(Error('journal write failed'));
}

// Unit / real installed O callbacks + durable journal. Previously only active
// 30-minute receipts were tested: expiry/restart could send a native ID to M2.
// Location grants no authority; the current guest and fresh lease still gate use.
describe('durable direct task routing', () => {
  const locate = (sessionId: string, peer = guestPeer) => state.hostDeps!.directGuestExecution!.locate!(peer,
    { op: 'direct-locate', sessionId });
  // Unit integration: O's live budget has no offline delegated enforcement.
  // Exercise real allocation, policy callback and M lease revocation together.
  it('withdraws direct leases when a member requires live budget checks, preserving history affinity', async () => {
    await installDirectHost();
    await allocate('budget-history');
    expect(delegation.delegatedProviderShareTaskAccess(guestPeer, 'budget-history')).not.toBeNull();
    state.delegatedAllowed = false;
    state.modelChanged!();
    await vi.waitFor(() => expect(delegation.delegatedProviderShareTaskAccess(guestPeer, 'budget-history')).toBeNull());
    expect(await allocate('budget-new')).toBeNull();
    expect(await allocate('budget-history')).toBeNull();
    expect(await locate('budget-history')).toEqual({ deviceId: 'one' });
    state.delegatedAllowed = true;
    expect((await allocate('budget-history'))?.deviceId).toBe('one');
  });
  it('renews the original M after 31 minutes and O restart, despite a new M2 plan', async () => {
    await installDirectHost();
    const first = await allocate('history');
    expect(first?.deviceId).toBe('one');
    disposeRemoteAgentHost();
    await state.usage!.flush();
    // Advance the persisted receipt's age instead of the OS file-lock clock.
    // This is the disk image an O restart sees 31 minutes after allocation.
    const persisted = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    for (const route of persisted.directReceiptRoutes) route.expiresAt -= 31 * 60_000;
    fs.writeFileSync(usageFile(), JSON.stringify(persisted));
    state.planDevice = 'two';
    await installDirectHost();
    expect(await allocate('history')).toMatchObject({ deviceId: 'one' });
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    expect(state.pair?.generation).not.toBe(first?.generation);
  });

  it('returns null for legacy history and never exposes another member or account location', async () => {
    await installDirectHost();
    expect(await allocate('history')).not.toBeNull();
    expect(await locate('legacy')).toBeNull();
    await expect(locate('history', providerShareGuestPeer('share', 'other-member', 'laptop'))).rejects.toThrow();
    state.approved = false;
    await expect(locate('history')).rejects.toThrow();
    state.approved = true;
    state.owner = 'another-account';
    await expect(locate('history')).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });

  it('keeps the pin and fails closed when M1 is unavailable or no longer allowed', async () => {
    await installDirectHost();
    expect(await allocate('history')).not.toBeNull();
    state.planDevice = 'two';
    state.offline.add('one');
    expect(await allocate('history')).toBeNull();
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    state.offline.clear();
    state.config!.members = state.config!.members.filter((member) => member.key !== 'device:one:openai');
    // Removal changes the new-task pool, not the location of existing history.
    expect(await allocate('history')).toMatchObject({ deviceId: 'one' });
    state.revoked = ['one'];
    expect(await allocate('history')).toBeNull();
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    expect(await state.hostDeps!.directGuestExecution!.allocate(guestPeer,
      { op: 'allocate', sessionId: 'history', agentKind: 'codex', model: 'gpt-5', preferredExecutorDeviceId: 'two' })).toBeNull();
  });

  it('clears the durable pin only when O accepts the switch token', async () => {
    await installDirectHost();
    expect(await allocate('history')).not.toBeNull();
    state.planDevice = 'two';
    const direct = state.hostDeps!.directGuestExecution!;
    const { token } = await direct.switch(guestPeer, { op: 'direct-switch', sessionId: 'history' });
    expect(token).toBeTruthy();
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    const handoff = vi.spyOn(state.usage!, 'markDirectTaskRelayed')
      .mockRejectedValueOnce(Error('handoff journal write failed'));
    await expect(direct.switched!(guestPeer, 'history', token!)).rejects.toThrow('handoff journal write failed');
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    handoff.mockRestore();
    await direct.switched!(guestPeer, 'history', token!);
    disposeRemoteAgentHost();
    await state.usage!.flush();
    await installDirectHost();
    expect(await locate('history')).toBeNull();
  });

  it('retains historical affinity on release but clears it on accepted fresh O fallback', async () => {
    await installDirectHost();
    const first = await allocate('history');
    const direct = state.hostDeps!.directGuestExecution!;
    await direct.release(guestPeer, { op: 'direct-release', sessionId: 'history', generation: first!.generation });
    expect(await locate('history')).toEqual({ deviceId: 'one' });
    await expect(direct.acceptRelay!(guestPeer, 'history', true)).rejects.toThrow();
    await direct.acceptRelay!(guestPeer, 'history', false);
    disposeRemoteAgentHost();
    await state.usage!.flush();
    await installDirectHost();
    expect(await locate('history')).toBeNull();
  });
});

// Production entry: installRemoteAgentHost's allocate + real M delegation/Fast
// receiver and durable stores. Unit tier; transport, server pair API and member
// selection are in-memory boundaries. Existing policy tests never allocated two
// tasks or paused between Fast confirmation and granting an executable M lease.
// Regression: B rollback must not revoke A's pair; group Fast prohibition must
// be durable and applied before a guest can start (provider-groups.md §15).
describe('direct allocation authorization and Fast prebinding', () => {
  it.each(['Fast', 'commit', 'register'] as const)(
    'keeps A executable when new B fails at %s', async (stage) => {
      await installDirectHost();
      expect(await allocate('task_a')).not.toBeNull();
      failAllocationAt(stage);
      expect(await allocate('task_b')).toBeNull();
      expect(state.pair).not.toBeNull();
      expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_a')).toBe(true);
      expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_b')).toBe(false);
      expect(state.usage!.listActiveDirectReceiptRoutes(state.owner).map((route) => route.sessionId))
        .toEqual(['task_a']);
    },
  );

  it.each(['Fast', 'commit', 'register'] as const)(
    'keeps sibling A authorized when B renewal and its restoration fail at %s', async (stage) => {
      await installDirectHost();
      expect(await allocate('task_a')).not.toBeNull();
      expect(await allocate('task_b')).not.toBeNull();
      failAllocationAt(stage);
      expect(await allocate('task_b')).toBeNull();
      expect(state.pair).not.toBeNull();
      expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_a')).toBe(true);
    },
  );

  it('revokes an unsuccessful allocation pair when no valid sibling needs it', async () => {
    await installDirectHost();
    failAllocationAt('Fast');
    expect(await allocate('task_b')).toBeNull();
    expect(state.pair).toBeNull();
    expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_b')).toBe(false);
  });

  it.each(['provisional', 'moved'] as const)(
    'does not preserve a pair for an obsolete committed sibling superseded by a %s assignment', async (latest) => {
      await installDirectHost();
      expect(await allocate('task_a')).not.toBeNull();
      const oldA = state.usage!.listActiveDirectReceiptRoutes(state.owner)[0];
      const newer = { ...oldA, generation: randomUUID(), committedAt: undefined,
        ...(latest === 'moved' ? { executorDeviceId: 'two', memberKey: 'device:two:openai' } : {}) };
      await state.usage!.registerDirectReceiptRoute(newer);
      if (latest === 'moved') await state.usage!.commitDirectReceiptRoute(newer);
      disposeRemoteAgentHost();
      await state.usage!.flush();
      await installDirectHost();
      failAllocationAt('Fast');
      expect(await allocate('task_b')).toBeNull();
      expect(state.pair).toBeNull();
    },
  );

  it('has no executable guest lease while durable Fast policy is still awaiting application', async () => {
    await installDirectHost();
    let entered!: () => void;
    let release!: () => void;
    const applying = new Promise<void>((resolve) => { entered = resolve; });
    const applied = new Promise<void>((resolve) => { release = resolve; });
    state.notify.mockImplementationOnce(() => { entered(); return applied; });
    const pending = allocate('task_a');
    await applying;
    const executableBeforeAck = delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_a');
    const fastBeforeAck = groupFastPolicyStore.allows(directTask('task_a'));
    release();
    expect(await pending).not.toBeNull();
    expect(executableBeforeAck).toBe(false);
    expect(fastBeforeAck).toBe(false);
    expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task_a')).toBe(true);
    // Read fresh store instances to verify the restriction crossed the restart boundary.
    const restarted = createGroupFastPolicyStore({ scopeKey: () => state.owner,
      filePath: () => path.join(temporary, state.owner, 'provider-group-fast-policy.json') });
    expect(restarted.allows(directTask('task_a'))).toBe(false);
  });

  it.each(['grant', 'Fast'] as const)(
    'preserves A after O restarts with provisional B and restoration fails at %s', async (stage) => {
      await installDirectHost();
      expect(await allocate('task_a')).not.toBeNull();
      expect(await allocate('task_b')).not.toBeNull();
      const oldB = state.usage!.listActiveDirectReceiptRoutes(state.owner).find((row) => row.sessionId === 'task_b')!;
      const provisional = { ...oldB, generation: randomUUID(), committedAt: undefined };
      await state.usage!.registerDirectReceiptRoute(provisional);
      state.pair = { ...state.pair!, generation: provisional.generation };
      disposeRemoteAgentHost();
      await state.usage!.flush();
      await installDirectHost();
      if (stage === 'grant') state.failGrant = true;
      else failAllocationAt('Fast');
      state.hostChanged!();
      await vi.waitFor(() => expect(state.delegateCalls.some((request) => request.op === 'delegate'
        && request.action === 'revoke' && request.generation === provisional.generation)).toBe(true));
      expect(state.pair).not.toBeNull();
      expect(state.usage!.listActiveDirectReceiptRoutes(state.owner)
        .some((row) => row.sessionId === 'task_a' && row.committedAt !== undefined)).toBe(true);
    },
  );
});

function blockCapabilitiesRequest() {
  let enter!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  state.beforeCaps = () => {
    enter();
    return blocked;
  };
  return {
    started,
    release() {
      state.beforeCaps = undefined;
      unblock();
    },
  };
}

describe('group owner to executor enforcement handshake', () => {
  it('coalesces repeated sync requests while the same offline revision is in flight', async () => {
    const caps = blockCapabilitiesRequest();
    // Only one remote endpoint makes the blocked request count unambiguous.
    state.config!.members = state.config!.members.slice(0, 1);
    state.offline.add('one');
    const pending = [runtime.syncGroupFastPolicy('openai')];
    try {
      // The request starts after durable writes and lock release; wait for that
      // event under the test deadline, without a shorter wall-clock poll.
      await Promise.race([caps.started, pending[0]]);
      expect(state.calls).toHaveLength(1);
      pending.push(...Array.from({ length: 5 }, () => runtime.syncGroupFastPolicy('openai')));
      caps.release();
      await Promise.all(pending);
      expect(state.calls).toHaveLength(1);
      expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    } finally {
      caps.release();
      await Promise.all(pending);
    }
  });

  it('reports a changed setting as pending before it has been sent to executors', async () => {
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    state.config!.allowFast = true;
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
  });

  it('still applies a newer setting requested while an earlier revision is in flight', async () => {
    const caps = blockCapabilitiesRequest();
    state.config!.members = state.config!.members.slice(0, 1);
    const pending = [runtime.syncGroupFastPolicy('openai')];
    try {
      await Promise.race([caps.started, pending[0]]);
      expect(state.calls).toHaveLength(1);
      state.config!.allowFast = true;
      pending.push(runtime.syncGroupFastPolicy('openai'));
      caps.release();
      await Promise.all(pending);
      expect(
        state.calls
          .filter(({ command }) => command.op === 'fast-policy')
          .map(({ command }) => command.allowFast),
      ).toEqual([false, true]);
      expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    } finally {
      caps.release();
      await Promise.all(pending);
    }
  });

  it('intersects a relay source with the executor local group and releases it even without a local member', async () => {
    const relay = 'abcdefghijklmnop';
    const task = hostSessionIdFor(`upstream\0relay:${relay}`, 'task');
    await groupFastPolicyStore.receive(
      'upstream',
      {
        group: 'outer',
        revision: 1,
        allowFast: true,
        binding: { sessionId: 'task', relay },
      },
      'self',
      () => {},
    );
    await runtime.bindLocalHostedGroupFastPolicy('openai', task);
    expect(groupFastPolicyStore.allows(task)).toBe(false);
    state.config!.allowFast = true;
    await runtime.syncGroupFastPolicy('openai');
    expect(groupFastPolicyStore.allows(task)).toBe(true);
    await groupFastPolicyStore.receive(
      'upstream',
      { group: 'outer', revision: 2, allowFast: false },
      'self',
      () => {},
    );
    expect(groupFastPolicyStore.allows(task)).toBe(false);
  });

  it('keeps offline and old executors pending, retries after recovery, and releases removed members with a newer revision', async () => {
    state.old.add('one');
    state.offline.add('two');
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    state.old.clear();
    state.offline.clear();
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    const revision = groupFastPolicyStore.outgoing().openai.revision;
    state.config!.members = state.config!.members.slice(1);
    state.calls = [];
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls).toContainEqual({
      device: 'one',
      command: expect.objectContaining({
        op: 'fast-policy',
        allowFast: true,
        revision: revision + 1,
      }),
    });
    expect(state.calls).toContainEqual({
      device: 'two',
      command: expect.objectContaining({
        op: 'fast-policy',
        allowFast: false,
        revision: revision + 1,
      }),
    });
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('does not grant a direct route before an old executor can enforce a prohibition', async () => {
    state.old.add('one');
    await expect(
      runtime.bindGroupFastPolicy({
        group: 'openai',
        deviceId: 'one',
        sessionId: 'task',
        controllerDeviceId: 'consumer',
      }),
    ).rejects.toThrow('REMOTE_AGENT_PEER_TOO_OLD');
    state.config!.allowFast = true;
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).resolves.toBeUndefined();
    await expect(runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task',
      providerShareGuest: { shareId: 'share', memberId: 'member', guestDeviceId: 'laptop' } }))
      .rejects.toThrow('REMOTE_AGENT_PEER_TOO_OLD');
  });

  it('binds an owner-approved direct guest task to the group Fast prohibition', async () => {
    const guest = { shareId: 'share', memberId: 'member', guestDeviceId: 'laptop' };
    const command = { group: 'openai', revision: 1, allowFast: false,
      binding: { sessionId: 'task', providerShareGuest: guest } };
    await expect(runtime.receiveGroupFastPolicy('owner', command)).rejects.toThrow('REMOTE_AGENT_INVALID');
    state.pair = { ownerDeviceId: 'owner', executorDeviceId: 'self',
      generation: randomUUID(), expiresAt: Date.now() + 60_000 };
    await expect(runtime.receiveGroupFastPolicy('another-owner', command)).rejects.toThrow('REMOTE_AGENT_INVALID');
    await runtime.receiveGroupFastPolicy('owner', command);
    const task = hostSessionIdFor(providerShareGuestPeer('share', 'member', 'laptop'), 'task');
    expect(groupFastPolicyStore.allows(task)).toBe(false);
    expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'task')).toBe(false);
    expect(state.check).toHaveBeenLastCalledWith({ ...guest, executorDeviceId: 'self' });
    // A previous task lease cannot substitute for a current server authorization.
    state.pair.expiresAt = Date.now() - 1;
    await expect(runtime.receiveGroupFastPolicy('owner', { ...command, revision: 2, allowFast: true }))
      .rejects.toThrow('REMOTE_AGENT_INVALID');
    expect(groupFastPolicyStore.allows(task)).toBe(false);
  });

  it('reports an unreachable executor as unavailable, without marking it as an old version', async () => {
    state.offline.add('one');
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });

  it('normalizes thrown transport errors so automatic group selection can try another member', async () => {
    state.broken.add('one');
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });

  it('forgets an acknowledged release and does not contact that removed member on later toggles', async () => {
    await runtime.syncGroupFastPolicy('openai');
    state.config!.members = state.config!.members.slice(1);
    await runtime.syncGroupFastPolicy('openai');
    expect(groupFastPolicyStore.outgoing().openai.targets).not.toHaveProperty('one');
    state.offline.add('one');
    state.calls = [];
    state.config!.allowFast = true;
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.some(({ device }) => device === 'one')).toBe(false);
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('shows local native failures as pending instead of acknowledging the whole group', async () => {
    state.config!.members.push({
      key: 'local',
      kind: 'local',
      agentDeviceId: null,
      providerId: 'openai',
      limit: 10,
      weight: 1,
      paused: false,
    });
    state.notify.mockRejectedValue(Error('native busy'));
    await expect(runtime.syncGroupFastPolicy('openai')).rejects.toThrow('native busy');
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    state.notify.mockResolvedValue(undefined);
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('does not touch custom API groups or their discovery/refresh paths', async () => {
    state.subscription = false;
    await runtime.syncGroupFastPolicy('openai');
    await runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' });
    expect(state.calls).toEqual([]);
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    expect(
      fs.existsSync(path.join(temporary, state.owner, 'provider-group-fast-policy.json')),
    ).toBe(false);
  });
});

// Unit / real O allocation + M delegation + usageStore. Existing budget tests
// change policy after publication; hold the durable commit to exercise F4's
// missing post-await admission, including rollback restoration of a previous lease.
describe('direct commit admission races', () => {
  it.each(['new', 'restore'] as const)('rejects a budget enabled during %s commit and retires that generation', async (stage) => {
    await installDirectHost();
    if (stage === 'restore') expect(await allocate('commit-race')).not.toBeNull();
    const commit = state.usage!.commitDirectReceiptRoute.bind(state.usage!);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let commits = 0;
    vi.spyOn(state.usage!, 'commitDirectReceiptRoute').mockImplementation(async (input) => {
      if (stage === 'restore' && ++commits === 1) throw new Error('injected first commit failure');
      entered();
      await gate;
      await commit(input);
    });
    const request = allocate('commit-race');
    await ready;
    state.delegatedAllowed = false;
    state.modelChanged!();
    release();
    expect(await request).toBeNull();
    expect(delegation.delegatedProviderShareTaskAccess(guestPeer, 'commit-race')).toBeNull();
    await vi.waitFor(() => expect(state.usage!.listActiveDirectReceiptRoutes(state.owner)).toEqual([]));
    expect(state.pair).toBeNull();
  });
  it('revokes only the failed model generation while an allowed sibling keeps its pair', async () => {
    await installDirectHost();
    const sibling = await allocate('sibling');
    expect(sibling).not.toBeNull();
    const access = (await import('../../device-link/remoteModelAccess.js')).remoteModelAccess;
    const commit = state.usage!.commitDirectReceiptRoute.bind(state.usage!);
    vi.spyOn(state.usage!, 'commitDirectReceiptRoute').mockImplementation(async (input) => {
      vi.spyOn(access, 'allowsDelegatedExecution').mockImplementation((_provider, model) => model !== 'gpt-6');
      state.modelChanged!();
      await commit(input);
    });
    const result = await state.hostDeps!.directGuestExecution!.allocate(guestPeer,
      { op: 'allocate', sessionId: 'failed-model', agentKind: 'codex', model: 'gpt-6' });
    expect(result).toBeNull();
    expect(delegation.delegatedProviderShareTaskAccess(guestPeer, 'failed-model')).toBeNull();
    expect(delegation.delegatedProviderShareSessionAllowed(guestPeer, 'sibling')).toBe(true);
    expect(delegation.delegatedProviderShareReceiptAuthority(guestPeer, 'sibling')?.generation).toBe(sibling!.generation);
    expect(state.pair).not.toBeNull();
    expect(state.usage!.listActiveDirectReceiptRoutes(state.owner).map((route) => route.sessionId)).toEqual(['sibling']);
  });
});

// A post-commit check must compare the freshly restored generation, not g1.
it('restores the previous authorized model after one failed renewal commit', async () => {
  await installDirectHost();
  const first = await allocate('renewal');
  expect(first).not.toBeNull();
  const commit = state.usage!.commitDirectReceiptRoute.bind(state.usage!);
  vi.spyOn(state.usage!, 'commitDirectReceiptRoute')
    .mockRejectedValueOnce(new Error('injected new model commit failure'))
    .mockImplementation(commit);
  expect(await state.hostDeps!.directGuestExecution!.allocate(guestPeer,
    { op: 'allocate', sessionId: 'renewal', agentKind: 'codex', model: 'gpt-6' })).toBeNull();
  expect(delegation.delegatedProviderShareModelAllowed(guestPeer, 'gpt-5', 'renewal')).toBe(true);
  expect(delegation.delegatedProviderShareModelAllowed(guestPeer, 'gpt-6', 'renewal')).toBe(false);
  const rows = state.usage!.listActiveDirectReceiptRoutes(state.owner);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sessionId: 'renewal', model: 'gpt-5' });
  expect(rows[0].generation).not.toBe(first!.generation);
});
