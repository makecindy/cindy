/** Unit integration: real O preparation and M admission wiring; only local I/O is replaced.
 * Bug/rule: an old peer must never receive the new op, and C must not choose Fast policy.
 * Gap: pure routing tests cannot verify capability negotiation or Main permission epochs.
 * Minimal input: O prepares one route, then C starts one different task on M. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, PROVIDER_GROUP_REMOTE_CHANNEL, REMOTE_AGENT_CHANNEL, encodeReliableFrames, parseTransportPayload } from '@cindy/device-link';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';
import type { GroupContinuityRequest } from '../../../shared/providerGroupContinuity.js';

// The continuity path only uses protocol/transport/channel constants. Keep those
// real SDK modules, but do not load the package root's unexecuted client/relay/
// direct/transfer assembly in this unit test.
vi.mock('@cindy/device-link', async () => import('./deviceLinkTestFacade.js'));

type PrepareWire = Extract<GroupContinuityRequest, { action: 'continuity-prepare' }>;

const io = vi.hoisted(() => ({
  owner: 'account', realm: 'realm', epoch: 0, allowed: true, ownSwitch: false, supported: true,
  remoteControl: true, revokedControllers: [] as string[], prepares: [] as unknown[],
  self: 'M',
  group: undefined as unknown, changed: undefined as undefined | ((group: string) => void),
  invoke: vi.fn(), receive: vi.fn(async () => {}), received: vi.fn(),
  slowInspect: false, entered: undefined as undefined | (() => void), inspectGate: Promise.resolve(),
  inspectError: undefined as undefined | Error,
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => io.owner }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => io.realm }));
vi.mock('../../device-link/index.js', () => ({ getRemoteLinkCloseEpoch: () => 0,
  getSelfDeviceId: () => io.self, remoteBackgroundInvoke: io.invoke }));
vi.mock('../../device-link/settings-store.desktop.js', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: io.remoteControl,
    revokedControllers: io.revokedControllers }),
}));
vi.mock('../../device-link/providerMetadataContinuity.js', () => ({ captureProviderMetadataContinuityScope: () => {
  const owner = io.owner, realm = io.realm; return () => owner === io.owner && realm === io.realm;
}, isTemporaryProviderMetadataFailure: (error: { code?: string }) =>
  ['NETWORK_ERROR', 'TIMEOUT', 'REMOTE_AGENT_UNAVAILABLE'].includes(error?.code ?? '') }));
vi.mock('../managementScope.js', () => ({ captureProviderManagementScope: () => {
  const owner = io.owner; return () => { if (owner !== io.owner) throw new Error('account changed'); };
} }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: () => io.allowed, remoteProviderAccessEpoch: () => String(io.epoch),
  isRemoteProviderOpenToOwnComputers: () => io.allowed || io.ownSwitch,
  onRemoteProviderAccessChanged: () => () => {},
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({
      listProviders: async () => {
        if (io.inspectError) throw io.inspectError;
        if (io.slowInspect) { io.entered?.(); await io.inspectGate; }
    return [{ id: 'openai', connected: true, source: 'user',
      models: { codex: [{ id: 'model', mode: 'chat' }] } }];
  },
}) }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({
  providers: [{ id: 'openai', auth: { method: 'oauth', native: 'codex' } }],
}) }));
vi.mock('../store.js', () => ({ readProviderGroup: () => io.group,
  onProviderGroupChanged: (listener: (group: string) => void) => { io.changed = listener; return () => {}; } }));
vi.mock('../fastPolicyStore.js', () => ({ groupFastPolicyStore: { received: io.received, receive: io.receive } }));
const { createGroupContinuityRuntime, GROUP_CONTINUITY_DELIVERY_BUDGET_MS } = await import('../continuityRuntime.js');
const { createGroupContinuityExecutor } = await import('../continuityExecutor.js');
const { bumpDeviceAccessGeneration, deviceAccessGeneration, isControllerAccessAllowed,
  noteControllerAccessAllowed, remoteControlAccessGeneration,
  syncRemoteControlAccessGeneration } = await import('../../device-link/remoteControlAccess.js');

function fixture() {
  const runtime = createGroupContinuityRuntime(async () => new Map([['openai', 2]]));
  io.invoke.mockImplementation(async (_target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
    options?.preSend?.();
    const wireArgs = JSON.parse(JSON.stringify(args)) as unknown[];
    if (channel === REMOTE_AGENT_CHANNEL) return { ok: true, result: { version: 1,
      agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024,
      maxPayloadBytes: 2048, ...(io.supported ? { groupContinuity: true } : {}) } };
    if ((wireArgs[0] as { action?: unknown })?.action === 'continuity-prepare') {
      io.prepares.push(JSON.parse(JSON.stringify(wireArgs[0])));
    }
    return { ok: true, result: await runtime.handle('O', wireArgs[0]) };
  });
  const member = normalizeProviderGroupConfig(io.group, 'openai')!.members[0];
  const prepare = () => runtime.prepare('C', { action: 'pick', providerId: 'openai', agentKind: 'codex',
    model: 'model', sessionId: 'initial', exclude: [] }, member);
  return { runtime, prepare };
}
function setRemoteControl(enabled: boolean): void {
  io.remoteControl = enabled;
  syncRemoteControlAccessGeneration();
}
beforeEach(() => {
  vi.clearAllMocks(); io.owner = 'account'; io.realm = 'realm'; io.epoch = 0; io.allowed = true; io.ownSwitch = false;
  io.supported = true;
  io.remoteControl = true; io.revokedControllers = []; io.prepares.length = 0; io.self = 'M';
  io.slowInspect = false; io.entered = undefined; io.inspectGate = Promise.resolve();
  io.inspectError = undefined;
  syncRemoteControlAccessGeneration();
  io.group = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
    members: [{ kind: 'device', agentDeviceId: 'M', providerId: 'openai' }] }, 'openai');
  io.received.mockReturnValue({ revision: 7, allowFast: false });
});

describe('group continuity Main wiring', () => {
  function makeMExecutor() {
    return createGroupContinuityExecutor({
      capture: (origin: string, controller: string) => {
        const controlGeneration = remoteControlAccessGeneration();
        const originAccess = deviceAccessGeneration(origin);
        const controllerAccess = deviceAccessGeneration(controller);
        return () => controlGeneration === remoteControlAccessGeneration()
          && originAccess === deviceAccessGeneration(origin)
          && controllerAccess === deviceAccessGeneration(controller)
          && isControllerAccessAllowed(origin) && isControllerAccessAllowed(controller);
      },
      inspect: async () => ({ running: 0, fastPolicyRequired: false }),
      bindFast: async () => {},
      wall: Date.now,
      mono: () => performance.now(),
    });
  }

  it('re-ACKs a prepared scope after M restart instead of returning a lost grant', async () => {
    const f = fixture();
    io.self = 'O';
    let executor = makeMExecutor();
    io.invoke.mockImplementation(async (_target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
      options?.preSend?.();
      if (channel === REMOTE_AGENT_CHANNEL) return { ok: true, result: { version: 1,
        agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048,
        groupContinuity: true } };
      const wireArgs = JSON.parse(JSON.stringify(args)) as unknown[];
      const action = (wireArgs[0] as { action?: string } | undefined)?.action;
      if (action === 'continuity-prepare' || action === 'continuity-revoke' || action === 'continuity-inspect') {
        return { ok: true, result: await executor.handle('O', wireArgs[0]) };
      }
      throw new Error('unexpected transport request');
    });
    const first = await f.prepare();
    expect(first).toBeDefined();
    await expect(executor.handle('C', { action: 'continuity-inspect', id: first!.id,
      ownerDeviceId: 'O', sessionId: 'before-restart' })).resolves.toMatchObject({ id: first!.id });

    // M process restart: a new real executor has no in-memory entries.
    executor = makeMExecutor();
    const second = await f.prepare();
    expect(second).toBeDefined();
    expect(second!.remainingMs).toBeLessThanOrEqual(first!.remainingMs);
    const inspected = await executor.handle('C', { action: 'continuity-inspect', id: second!.id,
      ownerDeviceId: 'O', sessionId: 'after-restart' }) as { id: string; remainingMs: number };
    expect(inspected).toMatchObject({ id: second!.id });
    expect(inspected.remainingMs).toBeLessThanOrEqual(first!.remainingMs);
    expect(io.invoke.mock.calls.some(call => call[2][0]?.action === 'continuity-revoke'
      && call[2][0]?.id === first!.id)).toBe(true);
    await expect(executor.handle('C', { action: 'continuity-admit', id: second!.id,
      ownerDeviceId: 'O', sessionId: 'after-restart' })).resolves.toMatchObject({ id: second!.id });
  });

  // Both an initial ACK and one with <10min left must retain the original M context.
  it.each([0, 20 * 60_000])('keeps a healthy ACK across a repeated O preparation after %ims', async elapsedMs => {
    const clock = { now: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    try {
      io.self = 'O';
      const f = fixture();
      const executor = makeMExecutor();
      io.invoke.mockImplementation(async (_target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        options?.preSend?.();
        if (channel === REMOTE_AGENT_CHANNEL) return { ok: true, result: { version: 1,
          agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048,
          groupContinuity: true } };
        const wireArgs = JSON.parse(JSON.stringify(args)) as unknown[];
        const action = (wireArgs[0] as { action?: string } | undefined)?.action;
        if (action === 'continuity-prepare' || action === 'continuity-revoke' || action === 'continuity-inspect') {
          return { ok: true, result: await executor.handle('O', wireArgs[0]) };
        }
        throw new Error('unexpected transport request');
      });
      const first = await f.prepare();
      expect(first).toBeDefined();
      await expect(executor.handle('C', { action: 'continuity-admit', id: first!.id,
        ownerDeviceId: 'O', sessionId: 'healthy-existing-task' })).resolves.toMatchObject({ id: first!.id });
      const prepares = io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare').length;
      clock.now = elapsedMs;
      const next = await f.prepare();
      expect(next).toBeDefined();
      expect(next!.id).toBe(first!.id);
      expect(next!.remainingMs).toBe(first!.remainingMs - elapsedMs);
      expect(io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare')).toHaveLength(prepares);
      expect(io.invoke.mock.calls.some(call => call[2][0]?.action === 'continuity-revoke')).toBe(false);
      await expect(executor.handle('C', { action: 'continuity-inspect', id: first!.id,
        ownerDeviceId: 'O', sessionId: 'healthy-existing-task' })).resolves.toMatchObject({ id: first!.id });
      await expect(executor.handle('O', { action: 'continuity-admit', id: first!.id,
        ownerDeviceId: 'O', sessionId: 'owner-cannot-admit' })).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });

  it('binds the policy received from O to a distinct C task, with live M provider/model/load checks', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant?.remainingMs).toBeGreaterThan(0);
    const request = { action: 'continuity-admit', id: grant!.id, ownerDeviceId: 'O', sessionId: 'new-task' };
    expect(await f.runtime.handle('C', request)).toMatchObject({ id: grant!.id, running: 2 });
    expect(io.received).toHaveBeenCalledWith('O', 'openai');
    expect(io.receive).toHaveBeenCalledExactlyOnceWith('O', { group: 'openai', revision: 7, allowFast: false,
      binding: { sessionId: 'new-task', controllerDeviceId: 'C' } }, 'M', expect.any(Function), undefined, true);
    io.received.mockReturnValue(undefined);
    await expect(f.runtime.handle('C', { ...request, sessionId: 'without-policy' }))
      .resolves.toMatchObject({ id: grant!.id });
    expect(io.receive).toHaveBeenLastCalledWith('O', { group: 'openai', revision: 0, allowFast: false,
      binding: { sessionId: 'without-policy', controllerDeviceId: 'C' } }, 'M', expect.any(Function), undefined, true);
  });
  it('deducts capability-probe time from the executor grant instead of starting a fresh window at M', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          clock.wall = clock.mono = 60_000;
        }
        return normal(target, channel, args, options);
      });
      const grant = await f.prepare();
      expect(grant?.remainingMs).toBe(29 * 60_000 - GROUP_CONTINUITY_DELIVERY_BUDGET_MS);
      clock.wall = clock.mono = 30 * 60_000 + 1;
      await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
        ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('deducts queue/open time at the send boundary and a delayed response does not renew the window', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let sentRemaining: number | undefined;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          clock.wall = clock.mono = 60_000;
        }
        if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          clock.wall = clock.mono = 100_000; // scheduler admission wait
          options?.preSend?.();
          clock.wall = clock.mono = 160_000; // link open/retry wait before the physical send
          options?.preSend?.();
          const wireArgs = JSON.parse(JSON.stringify(args)) as Array<{ grant: { remainingMs: number } }>;
          sentRemaining = wireArgs[0].grant.remainingMs;
          const reply = await normal(target, channel, args, options);
          clock.wall = clock.mono = 170_000; // ack arrives after another 10s
          return reply;
        }
        return normal(target, channel, args, options);
      });
      const grant = await f.prepare();
      expect(sentRemaining).toBe(30 * 60_000 - 160_000 - GROUP_CONTINUITY_DELIVERY_BUDGET_MS);
      expect(grant?.remainingMs).toBe(30 * 60_000 - 170_000 - GROUP_CONTINUITY_DELIVERY_BUDGET_MS);
      expect(170_000 + grant!.remainingMs).toBe(160_000 + sentRemaining!);
      clock.wall = clock.mono = 160_000 + sentRemaining!;
      await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
        ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('does not send an expired prepare at the send boundary', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let delivered = false;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          clock.wall = clock.mono = 60_000;
        }
        if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          clock.wall = clock.mono = 30 * 60_000 + 1;
          options?.preSend?.();
          delivered = true;
        }
        return normal(target, channel, args, options);
      });
      expect(await f.prepare()).toBeUndefined();
      expect(delivered).toBe(false);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('freezes the first reliable payload so a re-encode cannot advance the grant deadline', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let firstRemaining: number | undefined;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          clock.wall = clock.mono = 60_000;
        }
        if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          clock.wall = clock.mono = 160_000;
          options?.preSend?.();
          const env = { v: PROTOCOL_VERSION, kind: 'invoke' as const, dst: 'M',
            payload: { channel, args } };
          const firstFrames = encodeReliableFrames(env, 'continuity-stream', 1, 1);
          const parsed = parseTransportPayload(firstFrames[0].payload);
          if (!parsed) throw new Error('expected reliable transport payload');
          const firstPayload = JSON.parse(parsed.data) as { args: PrepareWire[] };
          firstRemaining = firstPayload.args[0].grant.remainingMs;
          const reply = { ok: true, result: await f.runtime.handle('O', firstPayload.args[0]) };
          clock.wall = clock.mono = 170_000;
          const replayFrames = encodeReliableFrames(env, 'continuity-stream', 1, 1); // retry/size measurement re-encode
          const replayPayload = parseTransportPayload(replayFrames[0].payload);
          if (!replayPayload) throw new Error('expected replay transport payload');
          const replayArgs = JSON.parse(replayPayload.data) as { args: PrepareWire[] };
          expect(replayArgs.args[0].grant.id).toBe(firstPayload.args[0].grant.id);
          expect(replayArgs.args[0].grant.remainingMs).toBe(firstRemaining);
          return reply;
        }
        return normal(target, channel, args, options);
      });
      const grant = await f.prepare();
      expect(firstRemaining).toBe(30 * 60_000 - 160_000 - GROUP_CONTINUITY_DELIVERY_BUDGET_MS);
      expect(grant?.remainingMs).toBe(30 * 60_000 - 170_000 - GROUP_CONTINUITY_DELIVERY_BUDGET_MS);
      expect(170_000 + grant!.remainingMs).toBe(160_000 + firstRemaining!);
      clock.wall = clock.mono = 160_000 + firstRemaining!;
      await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
        ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('does not publish a prepare acknowledgement delivered after the send budget', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          const reply = await normal(target, channel, args, options);
          clock.wall = clock.mono = 50_000; // delayed ack; its expiry timer has not run
          return reply;
        }
        return normal(target, channel, args, options);
      });
      expect(await f.prepare()).toBeUndefined();
      await vi.waitFor(() => expect(io.invoke.mock.calls.some(call =>
        call[1] === PROVIDER_GROUP_REMOTE_CHANNEL
        && (call[2][0] as { action?: unknown })?.action === 'continuity-revoke')).toBe(true));
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it.each(['wall', 'mono'] as const)('rejects admission when only the %s clock reaches the original window', async boundary => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const grant = await f.prepare();
      clock[boundary] = 30 * 60_000 + 1;
      await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
        ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('does not install an executor context when the original window is exhausted before prepare', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          clock.wall = clock.mono = 30 * 60_000;
        }
        return normal(target, channel, args, options);
      });
      expect(await f.prepare()).toBeUndefined();
      expect(io.invoke.mock.calls.some(call => call[1] === PROVIDER_GROUP_REMOTE_CHANNEL
        && (call[2][0] as { action?: unknown })?.action === 'continuity-prepare')).toBe(false);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });

  it('does not send preparation to legacy M or delay every later online pick on capability negotiation', async () => {
    io.supported = false; const f = fixture();
    expect(await f.prepare()).toBeUndefined(); expect(await f.prepare()).toBeUndefined();
    expect(io.invoke).toHaveBeenCalledTimes(1);
    expect(io.invoke.mock.calls[0][1]).toBe(REMOTE_AGENT_CHANNEL);
  });
  it('starts a fresh preparation after a timed-out capability probe instead of joining it forever', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let capsCalls = 0;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
          capsCalls += 1;
          if (capsCalls === 1) return new Promise(() => undefined);
        }
        return normal(target, channel, args, options);
      });
      const first = f.prepare();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toBeUndefined();
      const second = f.prepare();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(second).resolves.toBeDefined();
      expect(capsCalls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('keeps a still-valid context when the near-expiry refresh probe fails', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      io.self = 'O';
      const f = fixture();
      const grant = await f.prepare();
      expect(grant).toBeDefined();
      clock.wall = clock.mono = 20 * 60_000 + 1;
      io.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK_ERROR', message: '[NETWORK_ERROR] probe failed' } });
      const refreshed = await f.prepare();
      expect(refreshed?.id).toBe(grant?.id);
      expect(refreshed?.remainingMs).toBeGreaterThan(0);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  // Test value
  // - Production entry / observable: createGroupContinuityRuntime().prepare receives the
  //   dispatch-shaped `[UNAVAILABLE] provider groups are not ready yet` reply from a peer
  //   that is still starting; the previously acknowledged context must stay usable.
  // - Rule: provider-groups.md short-outage section: a temporarily unavailable computer
  //   must not erase a context already acknowledged by O and M.
  // - Gap: existing near-expiry cases cover thrown NETWORK_ERROR/TIMEOUT and explicit
  //   ACCESS_REVOKED/REMOTE_DISABLED results, but not dispatch's wrapped [UNAVAILABLE].
  // - Minimal failing input: prepare once, pass the refresh threshold, then return
  //   [UNAVAILABLE] for the prepare RPC.
  // - Tier: unit (existing in-memory wiring fixture; only transport is mocked).
  // - Measured: 3.7s for the whole file with `pnpm --dir apps/desktop exec vitest run
  //   src/main/provider-group/__tests__/continuityRuntime.test.ts` on this machine.
  it('keeps a still-valid context when the executor group handler is not ready yet', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      io.self = 'O';
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let notReady = false;
      io.invoke.mockImplementation(async (target, channel, args, options) => {
        if (notReady && channel === PROVIDER_GROUP_REMOTE_CHANNEL
          && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          return { ok: false, error: { code: 'IPC_ERROR',
            message: '[UNAVAILABLE] provider groups are not ready yet' } };
        }
        return normal(target, channel, args, options);
      });
      const grant = await f.prepare();
      clock.wall = clock.mono = 20 * 60_000 + 1;
      notReady = true;
      const refreshed = await f.prepare();
      expect(refreshed?.id).toBe(grant?.id);
      expect(refreshed?.remainingMs).toBeGreaterThan(0);
      expect(io.invoke.mock.calls.some(call => call[2][0]?.action === 'continuity-revoke')).toBe(false);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it.each(['ACCESS_REVOKED', 'REMOTE_DISABLED'])('invalidates a near-expiry context after a verification %s result', async code => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      io.self = 'O';
      const f = fixture();
      await f.prepare();
      clock.wall = clock.mono = 20 * 60_000 + 1;
      io.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_ERROR', message: `[${code}] executor stopped` } });
      expect(await f.prepare()).toBeUndefined();
      expect(io.invoke.mock.calls.some(call => call[2][0]?.action === 'continuity-revoke')).toBe(true);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });

  it('retires only the checked ACK when owner verification denies after fallback', async () => {
    io.self = 'O';
    const f = fixture();
    const first = await f.prepare();
    const member = normalizeProviderGroupConfig(io.group, 'openai')!.members[0]!;
    const neighbor = await f.runtime.prepare('D', { action: 'pick', providerId: 'openai',
      agentKind: 'codex', model: 'model', sessionId: 'neighbor-task', exclude: [] }, member);
    expect(first).toBeDefined(); expect(neighbor).toBeDefined();
    const normal = io.invoke.getMockImplementation()!;
    let reject!: (error: Error) => void;
    io.invoke.mockImplementation(async (target, channel, args, options) => {
      if (channel === PROVIDER_GROUP_REMOTE_CHANNEL
        && (args[0] as { action?: string; id?: string })?.action === 'continuity-inspect'
        && (args[0] as { id?: string }).id === first!.id) {
        return new Promise<never>((_resolve, rejectRequest) => { reject = rejectRequest; });
      }
      return normal(target, channel, args, options);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = f.prepare();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ id: first!.id });
      io.invoke.mockImplementation(normal);
      reject(Object.assign(new Error('[ACCESS_REVOKED] executor stopped'), { code: 'ACCESS_REVOKED' }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: first!.id,
        ownerDeviceId: 'O', sessionId: 'checked-task' })).rejects.toThrow('ACCESS_REVOKED');
      await expect(f.runtime.handle('D', { action: 'continuity-inspect', id: neighbor!.id,
        ownerDeviceId: 'O', sessionId: 'neighbor-task' })).resolves.toMatchObject({ id: neighbor!.id });
    } finally { vi.useRealTimers(); }
  });

  it('keeps the previous context when verification throws NETWORK_ERROR', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      io.self = 'O';
      const f = fixture();
      const grant = await f.prepare();
      clock.wall = clock.mono = 20 * 60_000 + 1;
      io.invoke.mockRejectedValueOnce(Object.assign(new Error('[NETWORK_ERROR] probe failed'), { code: 'NETWORK_ERROR' }));
      expect((await f.prepare())?.id).toBe(grant?.id);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  it('invalidates a near-expiry context after a prepare ACCESS_REVOKED result', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    try {
      io.self = 'O';
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let deny = false;
      io.invoke.mockImplementation(async (target, channel, args, options) => {
        if (deny && channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: string })?.action === 'continuity-inspect') {
          return { ok: true, result: { id: (args[0] as { id: string }).id, remainingMs: 0 } };
        }
        if (deny && channel === PROVIDER_GROUP_REMOTE_CHANNEL && (args[0] as { action?: unknown })?.action === 'continuity-prepare') {
          return { ok: false, error: { code: 'IPC_ERROR', message: '[ACCESS_REVOKED] executor stopped' } };
        }
        return normal(target, channel, args, options);
      });
      await f.prepare();
      clock.wall = clock.mono = 20 * 60_000 + 1;
      deny = true;
      expect(await f.prepare()).toBeUndefined();
      expect(io.invoke.mock.calls.some(call => call[2][0]?.action === 'continuity-revoke')).toBe(true);
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
  });
  // Unit integration: a real restarted M reports the old id missing. A timeout
  // before that evidence may retain an ACK; after it, O must await a new M ACK.
  // Gap: the former TIMEOUT case incorrectly expected a known-dead id back.
  // Cover rejected/pending replacement and a missing reply arriving after the
  // soft verification fallback; retry must keep the original two-clock budget.
  it.each(['TIMEOUT', 'PENDING', 'LATE_ZERO'] as const)(
    'does not redeliver a missing M context when replacement encounters %s', async failure => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      io.self = 'O';
      const f = fixture();
      const normal = io.invoke.getMockImplementation()!;
      let executor = makeMExecutor();
      let replacing = false;
      let releaseVerify: (() => Promise<void>) | undefined;
      io.invoke.mockImplementation(async (target: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
        if (channel === REMOTE_AGENT_CHANNEL) return normal(target, channel, args, options);
        options?.preSend?.();
        const command = JSON.parse(JSON.stringify(args))[0] as GroupContinuityRequest;
        if (replacing && command.action === 'continuity-inspect' && failure === 'LATE_ZERO') {
          return new Promise(resolve => {
            releaseVerify = async () => { resolve({ ok: true, result: await executor.handle('O', command) }); };
          });
        }
        if (replacing && command.action === 'continuity-prepare') {
          if (failure === 'PENDING') return new Promise(() => undefined);
          throw Object.assign(new Error('[TIMEOUT] prepare timed out'), { code: 'TIMEOUT' });
        }
        return { ok: true, result: await executor.handle('O', command) };
      });
      const startedAt = Date.now();
      const first = await f.prepare();
      expect(first).toBeDefined();
      executor = makeMExecutor();
      replacing = true;
      const pending = f.prepare();
      await vi.advanceTimersByTimeAsync(2_000);
      if (failure === 'LATE_ZERO') {
        await expect(pending).resolves.toMatchObject({ id: first!.id });
        expect(releaseVerify).toBeDefined();
        await releaseVerify!();
        await vi.advanceTimersByTimeAsync(0);
        const afterMissing = f.prepare();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(afterMissing).resolves.toBeUndefined();
      } else {
        await expect(pending).resolves.toBeUndefined();
      }
      await expect(executor.handle('C', { action: 'continuity-inspect', id: first!.id,
        ownerDeviceId: 'O', sessionId: 'dead-context' })).rejects.toThrow('ACCESS_REVOKED');
      replacing = false;
      const recovered = await f.prepare();
      expect(recovered).toBeDefined();
      expect(recovered!.id).not.toBe(first!.id);
      expect(recovered!.remainingMs).toBeLessThanOrEqual(first!.remainingMs - (Date.now() - startedAt));
      await expect(executor.handle('C', { action: 'continuity-admit', id: recovered!.id,
        ownerDeviceId: 'O', sessionId: 'recovered-context' })).resolves.toMatchObject({ id: recovered!.id });
    } finally { vi.useRealTimers(); }
  });
  it('does not let a late legacy caps result poison a newer prepared context', async () => {
    io.self = 'O';
      const f = fixture();
    const normal = io.invoke.getMockImplementation()!;
    let release!: () => void;
    let firstCaps = true;
    io.invoke.mockImplementation(async (target, channel, args, options) => {
      if (firstCaps && channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
        firstCaps = false;
        return new Promise(resolve => { release = () => resolve({ ok: true, result: { version: 1,
          agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 } }); });
      }
      return normal(target, channel, args, options);
    });
    vi.useFakeTimers();
    try {
      const first = f.prepare();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toBeUndefined();
      const second = await f.prepare();
      expect(second).toBeDefined();
      release();
      await Promise.resolve();
      await Promise.resolve();
      await expect(f.prepare()).resolves.toBeDefined();
    } finally { vi.useRealTimers(); }
  });
  it('does not send an old prepare after a newer context was prepared', async () => {
    io.self = 'O';
      const f = fixture();
    const normal = io.invoke.getMockImplementation()!;
    let release!: () => void;
    let firstCaps = true;
    io.invoke.mockImplementation(async (target, channel, args, options) => {
      if (firstCaps && channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps') {
        firstCaps = false;
        return new Promise(resolve => { release = () => resolve({ ok: true, result: { version: 1,
          agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048,
          groupContinuity: true } }); });
      }
      return normal(target, channel, args, options);
    });
    vi.useFakeTimers();
    try {
      const first = f.prepare();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toBeUndefined();
      const second = await f.prepare();
      expect(second).toBeDefined();
      const prepares = io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare').length;
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare')).toHaveLength(prepares);
      // A late superseded flight cannot replace the newer acknowledged row.
      await expect(f.prepare()).resolves.toMatchObject({ id: second!.id });
      expect(io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare'))
        .toHaveLength(prepares);
    } finally { vi.useRealTimers(); }
  });
  it('fences an in-flight probe across a group generation A to B to A', async () => {
    const clock = { wall: 0, mono: 0 };
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    const f = fixture();
    const original = io.group;
    const normal = io.invoke.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let capsCalls = 0;
    io.invoke.mockImplementation(async (target, channel, args, options) => {
      if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps' && ++capsCalls === 2) {
        return new Promise(resolve => { release = () => resolve({ ok: true, result: { version: 1,
          agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048,
          groupContinuity: true } }); entered(); });
      }
      return normal(target, channel, args, options);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await f.prepare();
      clock.wall = clock.mono = 30 * 60_000 + 1;
      const refresh = f.prepare();
      await started;
      io.group = { ...(original as object), autoSwitch: false }; io.changed!('openai');
      io.group = original; io.changed!('openai');
      release();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await refresh;
      const prepares = io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare').length;
      expect(prepares).toBe(1);
    } finally {
      date.mockRestore();
      mono.mockRestore();
      vi.useRealTimers();
    }
  });
  it('fences an in-flight prepare when the controller is revoked before M is prepared', async () => {
    const f = fixture();
    const normal = io.invoke.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    io.invoke.mockImplementation(async (target, channel, args, options) => {
      if (channel === REMOTE_AGENT_CHANNEL && (args[0] as { op?: unknown })?.op === 'caps' && !release) {
        return new Promise(resolve => {
          release = () => resolve({ ok: true, result: { version: 1,
            agents: [{ kind: 'codex', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048,
            groupContinuity: true } });
          entered();
        });
      }
      return normal(target, channel, args, options);
    });
    const first = f.prepare();
    await started;
    io.revokedControllers = ['C'];
    bumpDeviceAccessGeneration('C');
    release();
    await expect(first).resolves.toBeUndefined();
    expect(io.invoke.mock.calls.filter(call => call[2][0]?.action === 'continuity-prepare')).toHaveLength(0);
    io.revokedControllers = [];
    noteControllerAccessAllowed('C');
    await expect(f.prepare()).resolves.toBeDefined();
  });
  it('revokes acknowledged contexts after a group configuration change', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant).toBeDefined();
    io.group = { ...(io.group as object), autoSwitch: false }; io.changed!('openai');
    await Promise.resolve();
    expect(io.invoke.mock.calls.some(call => call[2][0].action === 'continuity-revoke')).toBe(true);
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
  });
  it('revokes a still-open context dropped after a changed group config was only observed', async () => {
    const f = fixture(), first = await f.prepare();
    expect(first).toBeDefined();
    // Another instance writes the shared group file; this process sees the new
    // config on read but never receives onProviderGroupChanged.
    io.group = { ...(io.group as object), autoSwitch: false };
    const second = await f.prepare();
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    const revoked = io.invoke.mock.calls
      .map(call => call[2][0] as { action?: string; id?: string })
      .filter(arg => arg?.action === 'continuity-revoke')
      .map(arg => arg.id);
    expect(revoked).toContain(first!.id);
  });
  it('does not resurrect a context after the local provider is disabled and enabled again', async () => {
    const f = fixture(), grant = await f.prepare(); expect(grant).toBeDefined();
    io.allowed = false; io.epoch++; io.allowed = true; io.epoch++;
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    expect(io.receive).not.toHaveBeenCalled();
  });
  // Bug(PR #10150 review)：M 的供应商只靠「让我的其他电脑用本机模型」开放时，直接启动任务能用，
  // 但组内续用的执行端核对只认「允许被远程调用」，O 暂时连不上后 C 拿未到期的续用去问 M 得到
  // ACCESS_REVOKED，在线的 M 被移出候选。修复前第一次 admit 拒绝，修复后放行；M 自己给这个供应商建了组时仍拒绝。
  it('admits a same-account continuity on M opened only by the own-computer switch, except a provider M groups itself', async () => {
    // 同一进程同时扮演 O 与 M：O 的组供应商逐个打开着才会准备续用；之后只把 M 侧状态换成「仅靠开关、没建组」。
    const f = fixture(), grant = await f.prepare(); expect(grant).toBeDefined();
    io.allowed = false; io.ownSwitch = true;
    const group = io.group; io.group = undefined;
    const request = { action: 'continuity-admit', id: grant!.id, ownerDeviceId: 'O', sessionId: 'new-task' };
    await expect(f.runtime.handle('C', request)).resolves.toMatchObject({ id: grant!.id, running: 2 });
    io.group = group;
    await expect(f.runtime.handle('C', { ...request, sessionId: 'grouped-on-m' })).rejects.toThrow('ACCESS_REVOKED');
  });
  it('does not serialize different owners through the production continuity handler', async () => {
    const f = fixture();
    const makes = (id: string) => ({ id, group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex' as const, model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 });
    const o1 = makes('grant-o1'), o2 = makes('grant-o2');
    await f.runtime.handle('O1', { action: 'continuity-prepare', grant: o1 });
    await f.runtime.handle('O2', { action: 'continuity-prepare', grant: o2 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    io.slowInspect = true; io.entered = entered; io.inspectGate = gate;
    io.received.mockReturnValue({ revision: 7, allowFast: true });
    vi.useFakeTimers();
    try {
      const slow = f.runtime.handle('C', { action: 'continuity-admit', id: o1.id, ownerDeviceId: 'O1', sessionId: 'slow' });
      await started;
      io.slowInspect = false;
      const fast = f.runtime.handle('C', { action: 'continuity-admit', id: o2.id, ownerDeviceId: 'O2', sessionId: 'fast' });
      const result = Promise.race([fast.then(() => 'fast'),
        new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 50))]);
      await vi.advanceTimersByTimeAsync(50);
      release(); await slow; await fast;
      expect(await result).toBe('fast');
    } finally {
      release(); io.slowInspect = false; vi.clearAllTimers(); vi.useRealTimers();
    }
  });
  // 测试价值
  // - 生产入口与可观察结果：真实 createGroupContinuityRuntime.handle 是 dispatch 的
  //   provider-group handler；本机开关关闭再开启后，旧 continuity-admit/inspect 必须拒绝，
  //   新的 O prepare 仍能成功。
  // - Bug/规则依据：provider-groups.md 短暂失联节「明确关闭、停止、撤权…结束对应保留」；
  //   关闭再开不能恢复已结束的旧 M continuity 窗口。
  // - 现有覆盖缺口：既有用例覆盖组配置/供应商权限失效与 TTL，但没有覆盖本机控制开关
  //   off→on 的旧 entry、迟到 prepare 和跨代 in-flight inspect/admit。
  // - 最小失败输入：准备一个 grant，随后 setRemoteControl(false)→true，再用原 grant admit；
  //   修复前返回 ack，修复后 ACCESS_REVOKED。
  // - tier：unit（现有 Main wiring fixture；无真实设备/账号）。
  // - 实测耗时：本文件约 3s（review/logs/50-f2-green-final2.log）。
  it('retires an old executor context when the local control switch closes and reopens', async () => {
    const f = fixture();
    const grant = await f.prepare();
    expect(grant).toBeDefined();
    const oldWire = io.prepares.at(-1) as Extract<GroupContinuityRequest, { action: 'continuity-prepare' }>;
    expect(oldWire.grant.id).toBe(grant!.id);
    setRemoteControl(false);
    setRemoteControl(true);
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'after-reopen' })).rejects.toThrow('ACCESS_REVOKED');
    // A delayed replay of the old prepare must not recreate the retired entry.
    await expect(f.runtime.handle('O', oldWire)).rejects.toThrow('ACCESS_REVOKED');
    const fresh = await f.prepare();
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(grant!.id);
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
      ownerDeviceId: 'O', sessionId: 'fresh' })).resolves.toMatchObject({ id: fresh!.id });
  });
  it.each(['continuity-inspect', 'continuity-admit'] as const)(
    'fences an in-flight %s after the local control switch changes', async action => {
      const f = fixture();
      const grant = await f.prepare();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      io.slowInspect = true; io.entered = entered; io.inspectGate = gate;
      try {
        const pending = f.runtime.handle('C', { action, id: grant!.id,
          ownerDeviceId: 'O', sessionId: 'inflight' });
        await started;
        setRemoteControl(false);
        setRemoteControl(true);
        release();
        await expect(pending).rejects.toThrow('ACCESS_REVOKED');
      } finally {
        io.slowInspect = false;
      }
    });
  it('fences an in-flight read when another instance writes the setting before the poll callback', async () => {
    const f = fixture();
    const grant = await f.prepare();
    const oldWire = io.prepares.at(-1) as Extract<GroupContinuityRequest, { action: 'continuity-prepare' }>;
    expect(oldWire.grant.id).toBe(grant!.id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    io.slowInspect = true; io.entered = entered; io.inspectGate = gate;
    try {
      const pending = f.runtime.handle('C', { action: 'continuity-inspect', id: grant!.id,
        ownerDeviceId: 'O', sessionId: 'external-change' });
      await started;
      io.remoteControl = false; // no sync: the capture must observe the file itself
      release();
      await expect(pending).rejects.toThrow('ACCESS_REVOKED');
      io.remoteControl = true; // permission restored, still before the normal poll
      await expect(f.runtime.handle('O', oldWire)).rejects.toThrow('ACCESS_REVOKED');
      syncRemoteControlAccessGeneration();
      await expect(f.runtime.handle('O', oldWire)).rejects.toThrow('ACCESS_REVOKED');
      const fresh = await f.prepare();
      expect(fresh).toBeDefined();
      expect(fresh!.id).not.toBe(grant!.id);
      await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
        ownerDeviceId: 'O', sessionId: 'fresh-after-external' })).resolves.toMatchObject({ id: fresh!.id });
    } finally {
      io.slowInspect = false;
    }
  });
  it('closes the entry when a live inspect is explicitly denied and rejects a replay', async () => {
    const f = fixture();
    const grant = await f.prepare();
    const oldWire = io.prepares.at(-1) as Extract<GroupContinuityRequest, { action: 'continuity-prepare' }>;
    io.inspectError = Object.assign(new Error('[ACCESS_REVOKED] provider disabled'), { code: 'ACCESS_REVOKED' });
    await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'inspect-denied' })).rejects.toThrow('ACCESS_REVOKED');
    io.inspectError = undefined;
    await expect(f.runtime.handle('O', oldWire)).rejects.toThrow('ACCESS_REVOKED');
  });
  it('keeps the entry after a temporary live-inspect failure and does not close it', async () => {
    const f = fixture();
    const grant = await f.prepare();
    io.inspectError = Object.assign(new Error('[REMOTE_AGENT_UNAVAILABLE] load not ready'),
      { code: 'REMOTE_AGENT_UNAVAILABLE' });
    await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'inspect-temporary' })).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    io.inspectError = undefined;
    await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'inspect-recovered' })).resolves.toMatchObject({ id: grant!.id });
  });
  it('retires only the revoked controller context and keeps a neighbor', async () => {
    const f = fixture();
    const grant = await f.prepare();
    const neighbor = { id: 'neighbor-grant', group: 'openai', controller: 'D',
      providerId: 'openai', agentKind: 'codex' as const, model: 'model',
      fastPolicyRequired: false, remainingMs: 1_800_000 };
    await f.runtime.handle('O', { action: 'continuity-prepare', grant: neighbor });
    bumpDeviceAccessGeneration('C');
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'revoked' })).rejects.toThrow('ACCESS_REVOKED');
    await expect(f.runtime.handle('D', { action: 'continuity-admit', id: neighbor.id,
      ownerDeviceId: 'O', sessionId: 'neighbor' })).resolves.toMatchObject({ id: neighbor.id });
  });
  it('does not retire a controller context when a different device is revoked', async () => {
    const f = fixture();
    const grant = await f.prepare();
    bumpDeviceAccessGeneration('M'); // the executor target, not this context's controller
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: grant!.id,
      ownerDeviceId: 'O', sessionId: 'unrelated-device' })).resolves.toMatchObject({ id: grant!.id });
  });
  it('rejects a prepare for a revoked controller and accepts it after restore', async () => {
    const f = fixture();
    const wire = { action: 'continuity-prepare' as const, grant: {
      id: 'revoked-grant', group: 'openai', controller: 'C', providerId: 'openai',
      agentKind: 'codex' as const, model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 } };
    io.revokedControllers = ['C'];
    await expect(f.runtime.handle('O', wire)).rejects.toThrow('ACCESS_REVOKED');
    io.revokedControllers = [];
    bumpDeviceAccessGeneration('C');
    await expect(f.runtime.handle('O', wire)).resolves.toMatchObject({ id: 'revoked-grant' });
  });
});

// F2-3: an explicit close observed by capture ends the old grant; a later external restore
// is a new permission, so the owner poll must not retire a fresh grant created after it.
// Gap: existing off->on cases call sync on both transitions, so they never model a capture-first
// close followed by the owner poll applying the restore.
// Minimal input: old prepare -> setting off (no sync) -> inspect -> setting on (no sync) ->
// fresh prepare/admit -> sync -> admit again.
// Tier: unit; real createGroupContinuityRuntime.handle, only settings/provider/load I/O replaced.
describe('F2-3 restore poll boundary', () => {
  it('keeps a fresh grant when the owner poll observes a restore after an off denial', async () => {
    const f = fixture();
    const old = await f.prepare();
    expect(old).toBeDefined();
    io.remoteControl = false; // external close, owner poll has not run
    await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: old!.id,
      ownerDeviceId: 'O', sessionId: 'off-observed' })).rejects.toThrow('ACCESS_REVOKED');
    io.remoteControl = true; // external restore, still before the owner poll
    const fresh = await f.prepare();
    expect(fresh).toBeDefined();
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
      ownerDeviceId: 'O', sessionId: 'fresh-before-poll' })).resolves.toMatchObject({ id: fresh!.id });
    syncRemoteControlAccessGeneration(); // owner poll applies the restore
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
      ownerDeviceId: 'O', sessionId: 'fresh-after-poll' })).resolves.toMatchObject({ id: fresh!.id });
  });
});

// F2-3: restoreController and the owner poll previously advanced the per-controller
// generation, which retired a fresh grant prepared between the restore and the poll.
// Gap: existing revoke/restore tests do not run the restore helper after a fresh grant.
// Minimal input: revoke+bump -> restore -> fresh prepare/admit -> restore helper -> admit.
// Tier: unit; real runtime handle, only settings/provider/load I/O replaced.
describe('F2-3 controller restore helper', () => {
  it('keeps a fresh controller grant when restore clears the denial episode', async () => {
    const f = fixture();
    const old = await f.prepare();
    io.revokedControllers = ['C'];
    bumpDeviceAccessGeneration('C'); // dispatch/revoke observation
    await expect(f.runtime.handle('C', { action: 'continuity-inspect', id: old!.id,
      ownerDeviceId: 'O', sessionId: 'revoked-observed' })).rejects.toThrow('ACCESS_REVOKED');
    io.revokedControllers = [];
    const fresh = await f.prepare();
    expect(fresh).toBeDefined();
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
      ownerDeviceId: 'O', sessionId: 'fresh-before-restore' })).resolves.toMatchObject({ id: fresh!.id });
    noteControllerAccessAllowed('C'); // restoreController / owner poll restored
    await expect(f.runtime.handle('C', { action: 'continuity-admit', id: fresh!.id,
      ownerDeviceId: 'O', sessionId: 'fresh-after-restore' })).resolves.toMatchObject({ id: fresh!.id });
  });
});
