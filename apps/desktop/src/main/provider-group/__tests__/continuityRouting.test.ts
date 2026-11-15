/** Unit: real group pick/client + M admission; only transport/local provider I/O is replaced.
 * Gap: an O outage previously blocked a new same-account task despite a healthy C↔M path.
 * Minimal input: one acknowledged route, O offline, then a distinct task. No paid/native invocation. */
import { describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer } from '@cindy/device-link';
import { normalizeProviderGroupConfig, parseProviderGroupRemotePick } from '../../../shared/providerGroup.js';
import type { GroupContinuityGrant } from '../../../shared/providerGroupContinuity.js';
import { createGroupContinuityExecutor } from '../continuityExecutor.js';
import { createGroupContinuityClient } from '../continuityClient.js';
import { ProviderGroupLocalCapacityError } from '../localCapacity.js';
import type { ProviderGroupRemoteClient, ProviderGroupRemoteInvoke } from '../remoteClient.js';

vi.mock('@cindy/device-link', async () => {
  const [protocol, metadata, group] = await Promise.all([
    import('../../../../../../packages/device-link/src/protocol.js'),
    import('../../../../../../packages/device-link/src/metadataContinuity.js'),
    import('../../../../../../packages/device-link/src/providerGroup.js'),
  ]);
  return {
    isProviderAccessDeniedError: metadata.isProviderAccessDeniedError,
    readProviderMetadataContinuity: metadata.readProviderMetadataContinuity,
    PROVIDER_METADATA_TRUST_MS: metadata.PROVIDER_METADATA_TRUST_MS,
    isScopedPeer: protocol.isScopedPeer,
    PROVIDER_GROUP_REMOTE_CHANNEL: group.PROVIDER_GROUP_REMOTE_CHANNEL,
    providerShareGuestPeer: protocol.providerShareGuestPeer,
  };
});


function fixture(options: { withLocal?: boolean } = {}) {
  const clock = { wall: 0, mono: 0, current: true, generation: 0, ownerOnline: true, allowed: true, running: 0 };
  const bind = vi.fn(async (_origin: string, _grant: GroupContinuityGrant, _task: string, current: () => boolean) => {
    if (!current()) throw new Error('revoked');
  });
  const inspect = vi.fn(async () => {
    if (!clock.allowed) throw new Error('[ACCESS_REVOKED] provider disabled');
    return { running: clock.running, fastPolicyRequired: true };
  });
  const executor = createGroupContinuityExecutor({ capture: () => () => clock.current, inspect, bindFast: bind,
    wall: () => clock.wall, mono: () => clock.mono });
  const config = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
    members: [
      ...(options.withLocal ? [{ kind: 'local' }] : []),
      { kind: 'device', agentDeviceId: 'M', providerId: 'openai' },
    ] }, 'openai')!;
  const member = config.members.find(candidate => candidate.kind === 'device')!;
  const localMember = config.members.find(candidate => candidate.kind === 'local');
  const grant: GroupContinuityGrant = { id: 'grant-1', group: 'openai', controller: 'C', providerId: 'openai',
    agentKind: 'codex', model: 'model', fastPolicyRequired: true, remainingMs: 1_800_000 };
  const livePick = vi.fn<ProviderGroupRemoteClient['pick']>(async () => {
    if (!clock.ownerOnline) throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
    const ack = await executor.handle('O', { action: 'continuity-prepare', grant });
    return parseProviderGroupRemotePick({ kind: 'member', member, label: 'M',
      continuity: { ...ack, config } }, 'openai');
  });
  const invoke = vi.fn<ProviderGroupRemoteInvoke>(async (_target, _channel, args, options) => {
    options?.preSend?.(); return { ok: true, result: await executor.handle('C', args[0]) };
  });
  const client = createGroupContinuityClient({ livePick, invoke, capture: () => {
    const generation = clock.generation; return () => clock.current && clock.generation === generation;
  },
    scopeKey: () => 'scope:' + clock.generation,
    ownerMayRespond: () => clock.ownerOnline, retryable: error => (error as { code?: string }).code === 'NOT_CONNECTED',
    wall: () => clock.wall, mono: () => clock.mono });
  const input = { providerId: 'openai', agentKind: 'codex' as const, model: 'model', exclude: [] as string[],
    allowOffline: true };
  return { clock, executor, config, grant, client, bind, inspect, invoke, livePick, input, localMember,
    pick: (task = 'task-1') => client.pick('O', { ...input, sessionId: task }) };
}

describe('same-account group continuity routing', () => {
  it('admits a new task directly on live M after five minutes of O outage, without renewing the original context', async () => {
    const f = fixture(); await f.pick();
    f.clock.wall = f.clock.mono = 300_000; f.clock.ownerOnline = false; f.clock.running = 3;
    expect(await f.pick('new-task')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.livePick).toHaveBeenCalledTimes(1);
    expect(f.inspect).toHaveBeenCalledTimes(2); // inspect and serialized admission both read M.
    expect(f.bind).toHaveBeenCalledExactlyOnceWith('O', f.grant, 'new-task', expect.any(Function));
    f.clock.wall = f.clock.mono = 1_800_001;
    await expect(f.pick('expired-task')).rejects.toThrow('owner offline');
    expect(f.bind).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'controller', 'model', 'task-peer', 'permission', 'account', 'wall', 'mono'] as const)('refuses a different or expired %s scope', async boundary => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    if (boundary === 'permission') f.clock.allowed = false;
    if (boundary === 'account') f.clock.current = false;
    if (boundary === 'wall') f.clock.wall = 1_800_001;
    if (boundary === 'mono') f.clock.mono = 1_800_001;
    if (boundary === 'model') f.input.model = 'other';
    if (['owner', 'controller', 'task-peer'].includes(boundary)) {
      const origin = boundary === 'task-peer' ? providerShareGuestPeer('s', 'm', 'G') : boundary === 'controller' ? 'other-C' : 'C';
      await expect(f.executor.handle(origin, { action: 'continuity-admit', id: f.grant.id,
        ownerDeviceId: boundary === 'owner' ? 'other-O' : 'O', sessionId: 'new-task' })).rejects.toThrow('ACCESS_REVOKED');
    } else await expect(f.pick('new-task')).rejects.toThrow();
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('refuses a self-issued prepare instead of letting the controller install its own grant', async () => {
    const f = fixture();
    await expect(f.executor.handle('C', { action: 'continuity-prepare',
      grant: { ...f.grant, id: 'self-issued' } })).rejects.toThrow('ACCESS_REVOKED');
    await expect(f.executor.handle('C', { action: 'continuity-admit', id: 'self-issued',
      ownerDeviceId: 'O', sessionId: 'self-task' })).rejects.toThrow('ACCESS_REVOKED');
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('uses current M load for concurrent admissions and does not reinterpret the group soft limit as a rejection', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false; f.clock.running = 99;
    await Promise.all([f.pick('A'), f.pick('B')]);
    expect(f.bind.mock.calls.map(call => call[2]).sort()).toEqual(['A', 'B']);
    const ack = await f.executor.handle('C', { action: 'continuity-inspect', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'C' });
    expect(ack).toMatchObject({ running: 101 });
  });
  it.each([
    { lane: 'controllers', firstOwner: 'O', secondOwner: 'O', firstController: 'C', secondController: 'D' },
    { lane: 'owners', firstOwner: 'O1', secondOwner: 'O2', firstController: 'C', secondController: 'C' },
  ])('does not block independent $lane using the same provider', async ({ firstOwner, secondOwner, firstController, secondController }) => {
    const f = fixture();
    const grantO1 = { ...f.grant, id: 'grant-o1', controller: firstController, fastPolicyRequired: false };
    const grantO2 = { ...f.grant, id: 'grant-o2', controller: secondController, fastPolicyRequired: false };
    await f.executor.handle(firstOwner, { action: 'continuity-prepare', grant: grantO1 });
    await f.executor.handle(secondOwner, { action: 'continuity-prepare', grant: grantO2 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.inspect.mockResolvedValue({ running: 0, fastPolicyRequired: false });
    f.inspect.mockImplementationOnce(async () => { entered(); await gate; return { running: 0, fastPolicyRequired: false }; });
    vi.useFakeTimers();
    try {
      const slow = f.executor.handle(firstController, { action: 'continuity-admit', id: grantO1.id,
        ownerDeviceId: firstOwner, sessionId: 'slow' });
      await started;
      const fast = f.executor.handle(secondController, { action: 'continuity-admit', id: grantO2.id,
        ownerDeviceId: secondOwner, sessionId: 'fast' });
      const result = Promise.race([fast.then(() => 'fast'),
        new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 50))]);
      await vi.advanceTimersByTimeAsync(50);
      release(); await slow;
      await fast;
      expect(await result).toBe('fast');
    } finally {
      release(); vi.clearAllTimers(); vi.useRealTimers();
    }
  });
  it('selects among two prepared executors using their live load without involving O or binding the other executor', async () => {
    const f = fixture();
    const second = { ...f.config.members[0], key: 'device:M2:openai', agentDeviceId: 'M2' };
    f.config.members.push(second);
    const secondBind = vi.fn(async () => {});
    const secondExecutor = createGroupContinuityExecutor({ capture: () => () => f.clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: true }), bindFast: secondBind,
      wall: () => f.clock.wall, mono: () => f.clock.mono });
    await f.pick('warm-M');
    const grant = { ...f.grant, id: 'grant-2' };
    const ack = await secondExecutor.handle('O', { action: 'continuity-prepare', grant });
    f.livePick.mockResolvedValueOnce(parseProviderGroupRemotePick({ kind: 'member', member: second, label: 'M2',
      continuity: { ...ack, config: f.config } }, 'openai'));
    await f.pick('warm-M2');
    f.invoke.mockImplementation(async (target, _channel, args, options) => {
      options?.preSend?.();
      return { ok: true, result: await (target === 'M2' ? secondExecutor : f.executor).handle('C', args[0]) };
    });
    f.clock.ownerOnline = false; f.clock.running = 10;
    expect(await f.pick('new-task')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M2' } });
    expect(f.bind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);
    expect(f.livePick).toHaveBeenCalledTimes(2);
  });

  it('spreads simultaneous offline picks across equally loaded prepared executors using their current reservations', async () => {
    const f = fixture();
    const second = { ...f.config.members[0], key: 'device:M2:openai', agentDeviceId: 'M2' };
    f.config.members.push(second);
    const secondExecutor = createGroupContinuityExecutor({ capture: () => () => f.clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: true }), bindFast: async () => {},
      wall: () => f.clock.wall, mono: () => f.clock.mono });
    await f.pick('warm-M');
    const ack = await secondExecutor.handle('O', { action: 'continuity-prepare', grant: { ...f.grant, id: 'grant-2' } });
    f.livePick.mockResolvedValueOnce(parseProviderGroupRemotePick({ kind: 'member', member: second, label: 'M2',
      continuity: { ...ack, config: f.config } }, 'openai'));
    await f.pick('warm-M2');
    f.invoke.mockImplementation(async (target, _channel, args, options) => {
      options?.preSend?.(); return { ok: true, result: await (target === 'M2' ? secondExecutor : f.executor).handle('C', args[0]) };
    });
    f.clock.ownerOnline = false;
    const picks = await Promise.all(Array.from({ length: 8 }, (_, i) => f.pick(`new-${i}`)));
    expect(picks.filter(pick => pick.kind === 'member' && pick.member.agentDeviceId === 'M')).toHaveLength(4);
    expect(picks.filter(pick => pick.kind === 'member' && pick.member.agentDeviceId === 'M2')).toHaveLength(4);
    expect(f.livePick).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent offline picks for the same task instead of admitting it twice', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    const [first, second] = await Promise.all([f.pick('same-task'), f.pick('same-task')]);
    expect(second).toEqual(first);
    expect(f.bind).toHaveBeenCalledTimes(1);
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick (used by provider-group/service.ts).
  // - Rule: one task must not be admitted/bound twice; the bounded flight table may backpressure
  //   new picks but must not bypass coalescing for a new key.
  // - Gap: at 512 in-flight picks the old code started a new key without installing a flight, so
  //   two identical concurrent picks for one task each ran admission.
  // - Minimal failing input: 512 distinct in-flight picks through the public client, then two
  //   identical owner-offline picks for one new task.
  // - Tier: unit, in-memory client/executor.
  it('backpressures new picks instead of admitting one task twice when the flight table is full', async () => {
    const f = fixture();
    await f.pick('warm');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.livePick.mockImplementation(() => gate.then(() => ({ kind: 'none' as const })));
    const fills = Array.from({ length: 512 }, (_, index) =>
      f.client.pick('O', { ...f.input, sessionId: 'fill-' + index }).catch(() => undefined));
    await Promise.resolve();
    f.clock.ownerOnline = false;
    const results = await Promise.allSettled([f.pick('duplicate'), f.pick('duplicate')]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(f.bind).not.toHaveBeenCalled();
    release();
    await Promise.all(fills);
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick.
  // - Rule: provider-groups.md short-outage section: one target's explicit failure must not clear
  //   another target's still-valid context; Fast is enforced by the executor at admission.
  // - Gap: a Fast binding failure is produced only for the selected member (send/caps/ack), but
  //   the old non-retryable branch invalidated every prepared member for the provider.
  // - Minimal failing input: two prepared executors, a Fast binding failure on the next live pick,
  //   then owner offline and a new task that should use the remaining prepared executor.
  // - Tier: unit, in-memory client/executor.
  it('keeps other prepared executors when one Fast policy binding fails', async () => {
    const f = fixture();
    const second = { ...f.config.members[0], key: 'device:M2:openai', agentDeviceId: 'M2' };
    f.config.members.push(second);
    const secondBind = vi.fn(async () => {});
    const secondExecutor = createGroupContinuityExecutor({ capture: () => () => f.clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: true }), bindFast: secondBind,
      wall: () => f.clock.wall, mono: () => f.clock.mono });
    await f.pick('warm-M');
    const ack = await secondExecutor.handle('O', { action: 'continuity-prepare', grant: { ...f.grant, id: 'grant-2' } });
    f.livePick.mockResolvedValueOnce(parseProviderGroupRemotePick({ kind: 'member', member: second, label: 'M2',
      continuity: { ...ack, config: f.config } }, 'openai'));
    await f.pick('warm-M2');
    f.invoke.mockImplementation(async (target, _channel, args, options) => {
      options?.preSend?.();
      if (target === 'M') {
        return { ok: false, error: { code: 'IPC_ERROR',
          message: '[REMOTE_AGENT_UNAVAILABLE] M transport failed' } };
      }
      return { ok: true, result: await secondExecutor.handle('C', args[0]) };
    });

    f.livePick.mockRejectedValueOnce(new Error(
      '[REMOTE_AGENT_UNAVAILABLE] Subscription Fast policy has not been confirmed',
    ));
    await expect(f.pick('fast-fail')).rejects.toThrow('Fast policy');
    f.clock.ownerOnline = false;
    expect(await f.pick('after-fast')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M2' } });
    expect(f.bind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick.
  // - Rule: an explicit ACCESS_REVOKED / REMOTE_DISABLED refusal is owner authority even when its
  //   message mentions Fast policy; it must invalidate prepared rows like any other refusal.
  // - Gap: a text-only Fast exemption would let a refusal containing "Fast policy" bypass the
  //   provider-wide invalidation.
  // - Minimal failing input: warm one executor, then a live pick rejects with the explicit code
  //   plus Fast text; taking the owner offline must not find that prepared row.
  // - Tier: unit, in-memory client/executor.
  it.each(['ACCESS_REVOKED', 'REMOTE_DISABLED'] as const)(
    'still invalidates prepared rows for an explicit %s refusal mentioning Fast policy', async (code) => {
      const f = fixture();
      await f.pick('warm');
      f.livePick.mockRejectedValueOnce(Object.assign(
        new Error('[' + code + '] Fast policy changed'),
        { code: 'IPC_ERROR' },
      ));
      await expect(f.pick('refused')).rejects.toThrow('Fast policy changed');
      f.clock.ownerOnline = false;
      await expect(f.pick('after-refusal')).rejects.toThrow('owner offline');
    });

  it('serves the acknowledged group config only while its routing context is valid', async () => {
    const f = fixture(); await f.pick();
    expect(f.client.readConfig('O', 'openai')).toEqual(f.config);
    expect(f.client.readConfig('O', 'other')).toBeNull();
    expect(f.client.readConfig('other-owner', 'openai')).toBeNull();
    f.clock.wall = f.clock.mono = 1_800_001;
    expect(f.client.readConfig('O', 'openai')).toBeNull();
  });

  it('keeps another executor prepared when a live pick has no continuity context', async () => {
    const f = fixture();
    const second = { ...f.config.members[0], key: 'device:M2:openai', agentDeviceId: 'M2' };
    f.config.members.push(second);
    await f.pick('warm-M');
    f.livePick.mockResolvedValueOnce({ kind: 'member', member: second, label: 'M2' });
    await f.pick('online-unprepared');
    f.clock.ownerOnline = false;
    expect(await f.pick('offline-after-unprepared')).toMatchObject({
      kind: 'member', member: { agentDeviceId: 'M' },
    });
  });

  it.each([false, undefined] as const)('does not inspect or admit a prepared executor for an existing task (allowOffline=%s)', async allowOffline => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    const mCalls = f.invoke.mock.calls.length;
    await expect(f.client.pick('O', { ...f.input, sessionId: 'existing-task', allowOffline }))
      .rejects.toThrow('owner offline');
    expect(f.invoke.mock.calls.length).toBe(mCalls);
    expect(f.client.readConfig('O', 'openai')).toEqual(f.config);
  });

  it('coalesces concurrent online picks for the same task before asking the owner twice', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.pick('same-task'), f.pick('same-task')]);
    expect(second).toEqual(first);
    expect(f.livePick).toHaveBeenCalledTimes(1);
  });

  it.each(['result', 'throw'] as const)('drops a prepared route after an explicit executor denial via %s', async mode => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    if (mode === 'result') {
      f.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_ERROR', message: '[ACCESS_REVOKED] provider removed' } });
    } else f.invoke.mockRejectedValueOnce(new Error('[ACCESS_REVOKED] provider removed'));
    await expect(f.pick('denied')).rejects.toThrow('NOT_CONNECTED');
    const calls = f.invoke.mock.calls.length;
    await expect(f.pick('after-denial')).rejects.toThrow();
    expect(f.invoke.mock.calls.length).toBe(calls);
  });

  it('does not let a stalled admission for one provider block another provider on the same executor', async () => {
    const f = fixture();
    const secondGrant = { ...f.grant, id: 'grant-2', group: 'other', providerId: 'other' };
    await f.executor.handle('O', { action: 'continuity-prepare', grant: f.grant });
    await f.executor.handle('O', { action: 'continuity-prepare', grant: secondGrant });
    let release!: () => void;
    f.inspect.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ running: 0, fastPolicyRequired: true });
    }));
    const first = f.executor.handle('C', { action: 'continuity-admit', id: f.grant.id,
      ownerDeviceId: 'O', sessionId: 'first' });
    await Promise.resolve();
    let secondSettled = false;
    const second = f.executor.handle('C', { action: 'continuity-admit', id: secondGrant.id,
      ownerDeviceId: 'O', sessionId: 'second' }).then((value) => { secondSettled = true; return value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(secondSettled).toBe(true);
    } finally {
      release();
    }
    await Promise.all([first, second]);
  });

  it('drops provisional reservations from an old executor account generation', async () => {
    const clock = { current: true, generation: 0, running: 0 };
    const executor = createGroupContinuityExecutor({
      capture: () => { const generation = clock.generation;
        return () => clock.current && generation === clock.generation; },
      inspect: async () => ({ running: clock.running, fastPolicyRequired: false }),
      bindFast: async () => {}, wall: () => 0, mono: () => 0,
    });
    const first: GroupContinuityGrant = { id: 'old-grant', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    const second = { ...first, id: 'new-grant' };
    await executor.handle('O', { action: 'continuity-prepare', grant: first });
    await executor.handle('C', { action: 'continuity-admit', id: first.id,
      ownerDeviceId: 'O', sessionId: 'old-task' });
    clock.generation++;
    await executor.handle('O', { action: 'continuity-prepare', grant: second });
    expect(await executor.handle('C', { action: 'continuity-inspect', id: second.id,
      ownerDeviceId: 'O', sessionId: 'new-task' })).toMatchObject({ running: 0 });
  });

  it('does not admit an old caller waiting in the group queue after the account generation changes and a new route is installed', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.inspect.mockImplementationOnce(async () => { entered(); await waiting; return { running: 0, fastPolicyRequired: true }; });
    const first = f.pick('old-1').catch(error => error);
    await started;
    const second = f.pick('old-2').catch(error => error);
    f.clock.generation++; f.clock.ownerOnline = true; await f.pick('new-owner-warm');
    f.clock.ownerOnline = false; release();
    const results = await Promise.all([first, second]);
    expect(results.every(result => result instanceof Error)).toBe(true);
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('samples live load for the next task instead of joining a previous timed-out inspection', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    vi.useFakeTimers();
    let release!: () => void;
    f.invoke.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ ok: true, result: { id: f.grant.id, remainingMs: 1_800_000, running: 0 } });
    }));
    try {
      const stalled = f.pick('stalled').catch(error => error);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await stalled).toBeInstanceOf(Error);
      expect(await f.pick('next')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
      expect(f.bind.mock.calls.map(call => call[2])).toEqual(['next']);
    } finally { release(); vi.useRealTimers(); }
  });

  it('does not turn an old/unprepared peer, a refusal or a quota rebalance into an offline route', async () => {
    const f = fixture();
    f.livePick.mockResolvedValueOnce({ kind: 'member', member: f.config.members[0], label: 'old M' });
    await f.pick(); f.clock.ownerOnline = false;
    await expect(f.pick('new-task')).rejects.toThrow('owner offline');
    f.clock.ownerOnline = true; await f.pick(); f.clock.ownerOnline = false;
    await expect(f.client.pick('O', { ...f.input, sessionId: 'rebalance', quotaRebalance: f.config.members[0].key })).rejects.toThrow('NOT_CONNECTED');
    f.clock.ownerOnline = true;
    f.livePick.mockRejectedValueOnce(Object.assign(new Error('[ACCESS_REVOKED] owner refused'), { code: 'ACCESS_REVOKED' }));
    await expect(f.pick('denied')).rejects.toThrow('ACCESS_REVOKED');
    f.clock.ownerOnline = false; await expect(f.pick('after-refusal')).rejects.toThrow('owner offline');
    expect(f.bind).not.toHaveBeenCalled();
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick (provider-group/service.ts
  //   assignFromRemoteGroup / resolveSwitchTarget consume its result kind).
  // - Rule: an authoritative owner answer that no member is available, or that the group is
  //   gone, must reach the caller as that result. Retiring the routes it prepared is local state,
  //   not a caller account/link change.
  // - Gap: the refusal cases above cover thrown errors and a warm member pick, but not the
  //   successful `none`/`unavailable` returns whose remember() advances this flight's own epoch.
  // - Minimal failing input: warm one prepared member, then return {kind:'unavailable'}; the
  //   post-flight scope check observed its own epoch advance and threw ACCESS_REVOKED.
  // - Tier: unit (real client/executor; transport and clock only).
  it('returns its own authoritative none/unavailable answer instead of a scope error', async () => {
    const f = fixture();
    await f.pick('warm');
    f.livePick.mockResolvedValueOnce({ kind: 'unavailable', usageLimit: { resetAtMs: 5_000_000 } });
    const [first, joined] = await Promise.all([f.pick('no-member'), f.pick('no-member')]);
    expect(first).toEqual({ kind: 'unavailable', usageLimit: { resetAtMs: 5_000_000 } });
    expect(joined).toEqual(first);
    // The authoritative answer retired the prepared route; an owner outage cannot admit it now.
    f.clock.ownerOnline = false;
    await expect(f.pick('after-unavailable')).rejects.toThrow('owner offline');
    expect(f.bind).not.toHaveBeenCalled();

    f.clock.ownerOnline = true;
    await f.pick('warm-again');
    f.livePick.mockResolvedValueOnce({ kind: 'none' });
    await expect(f.pick('group-gone')).resolves.toEqual({ kind: 'none' });
    f.clock.ownerOnline = false;
    await expect(f.pick('after-none')).rejects.toThrow('owner offline');
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('fences revoked and in-flight contexts and keeps repeated preparation at its original deadline', async () => {
    const f = fixture(); await f.pick();
    f.clock.wall = f.clock.mono = 1000;
    expect(await f.executor.handle('O', { action: 'continuity-prepare', grant: f.grant })).toMatchObject({ remainingMs: 1_799_000 });
    let finish!: () => void;
    f.inspect.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; });
      return { running: 0, fastPolicyRequired: true }; });
    const pending = f.executor.handle('C', { action: 'continuity-admit', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'new-task' });
    void pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
    await f.executor.handle('O', { action: 'continuity-revoke', id: f.grant.id }); finish();
    await expect(pending).rejects.toThrow('ACCESS_REVOKED');
    await expect(f.executor.handle('O', { action: 'continuity-prepare', grant: f.grant })).rejects.toThrow('ACCESS_REVOKED');
    expect(f.bind).not.toHaveBeenCalled();
  });

  // Test value
  // - Production entry/observable result: createGroupContinuityClient.pick (the real routing
  //   entry used by provider-group/service.ts); a new task still lands on a previously
  //   acknowledged M after O goes offline.
  // - Rule: provider-groups.md short-outage section: choose only among previously confirmed
  //   M, and one target's failure must not clear another target's context.
  // - Coverage gap: the old case used a single-member fixture and faked a local member that
  //   was not in the group config. This case uses one real config containing local + M.
  // - Minimal failing input: prepare M, then let the next live pick return that config local
  //   member (no continuity), then take O offline and admit M.
  // - Tier: unit (in-memory routing fakes), same file as the other routing cases.
  it('keeps the configured M prepared when a live pick selects the same config local member', async () => {
    const f = fixture({ withLocal: true });
    expect(f.config.members.map(candidate => candidate.kind)).toEqual(['local', 'device']);
    await f.pick();
    expect(f.localMember).toBeDefined();
    f.livePick.mockResolvedValueOnce({ kind: 'member', member: f.localMember!, label: 'O' });
    expect(await f.pick('local-task')).toMatchObject({ kind: 'member',
      member: { key: f.localMember!.key, kind: 'local', agentDeviceId: null } });
    expect(f.config.members.map(candidate => candidate.kind)).toEqual(['local', 'device']);
    f.clock.ownerOnline = false;
    expect(await f.pick('after-local')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.bind).toHaveBeenCalledExactlyOnceWith('O', f.grant, 'after-local', expect.any(Function));
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick/forgetGroup (used by provider-group/service.ts).
  // - Rule: the short-outage contract ends a group's prepared routing context when a live directory
  //   read confirms deletion, including replies from picks already in flight.
  // - Gap: forgetGroup only deleted stored rows; a late successful pick could remember its old grant
  //   and a subsequent owner outage could admit a new task through the deleted group.
  // - Minimal failing input: pending live pick, forgetGroup, then its old member+continuity reply.
  // - Tier: unit (real client/executor; transport and provider deps only).
  it('does not let a late pre-deletion pick resurrect the forgotten group', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.livePick.getMockImplementation()!;
    f.livePick.mockImplementationOnce(async (owner, input) => { await gate; return original(owner, input); });
    const old = f.pick('pending');
    f.client.forgetGroup('O', 'openai');
    expect(f.client.readConfig('O', 'openai')).toBeNull();
    release();
    await expect(old).rejects.toThrow('ACCESS_REVOKED');
    expect(f.client.readConfig('O', 'openai')).toBeNull();
    expect(f.bind).not.toHaveBeenCalled();

    f.clock.ownerOnline = false;
    await expect(f.pick('after-delete')).rejects.toThrow('owner offline');
    expect(f.bind).not.toHaveBeenCalled();

    // A new positive O confirmation after the deletion must still be usable.
    f.clock.ownerOnline = true;
    expect(await f.pick('fresh')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    f.clock.ownerOnline = false;
    expect(await f.pick('after-fresh')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
  });

  it('keeps a neighbour provider usable when another group is forgotten', async () => {
    const f = fixture();
    const otherConfig = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true, allowFast: false,
      members: [{ kind: 'device', agentDeviceId: 'M2', providerId: 'anthropic' }] }, 'anthropic')!;
    const otherGrant = { ...f.grant, id: 'grant-other', group: 'anthropic', providerId: 'anthropic' };
    const otherAck = await f.executor.handle('O', { action: 'continuity-prepare', grant: otherGrant });
    f.livePick.mockResolvedValueOnce(parseProviderGroupRemotePick({ kind: 'member', member: otherConfig.members[0],
      label: 'M2', continuity: { ...otherAck, config: otherConfig } }, 'anthropic'));
    await f.client.pick('O', { ...f.input, providerId: 'anthropic', sessionId: 'warm-other' });
    await f.pick('warm-openai');

    f.client.forgetGroup('O', 'openai');
    expect(f.client.readConfig('O', 'openai')).toBeNull();
    expect(f.client.readConfig('O', 'anthropic')).toEqual(otherConfig);
    f.clock.ownerOnline = false;
    expect(await f.client.pick('O', { ...f.input, providerId: 'anthropic', sessionId: 'after-other', allowOffline: true }))
      .toMatchObject({ kind: 'member', member: { agentDeviceId: 'M2' } });
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick rejection path after forgetGroup.
  // - Rule: a deletion starts a new generation; a late failure callback from the old
  //   generation must not clear rows created by a new online O confirmation.
  // - Gap: the old provider-wide invalidate deleted rows regardless of the flight's epoch.
  // - Minimal failing input: old pick pending, forgetGroup, new positive pick, then old rejection.
  // - Tier: unit (real client/executor; transport and provider deps only).
  it('does not let an old pick failure clear a post-deletion confirmation', async () => {
    const f = fixture();
    let rejectOld!: (error: unknown) => void;
    const gate = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    f.livePick.mockImplementationOnce(() => gate);
    const old = f.pick('old-generation');
    f.client.forgetGroup('O', 'openai');
    await expect(f.pick('new-generation')).resolves.toMatchObject({ kind: 'member' });
    rejectOld(Object.assign(new Error('[ACCESS_REVOKED] old owner refused'), { code: 'ACCESS_REVOKED' }));
    await expect(old).rejects.toThrow('ACCESS_REVOKED');
    expect(f.client.readConfig('O', 'openai')).not.toBeNull();
    f.clock.ownerOnline = false;
    expect(await f.pick('after-old-failure')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick/forgetGroup (used by service.ts).
  // - Rule: unrelated failed operations or unknown deletions must not retire another
  //   target's valid routing context; only real memory pressure may be a capacity error.
  // - Gap: a 512-entry scope table unconditionally evicted the healthy scope even when
  //   only one positive row existed and the other operations never created rows.
  // - Minimal failing input: one healthy context + 512 unknown forgets + 512 failed owner picks.
  // - Tier: unit (real client/executor; transport and clock only).
  it('does not let unrelated forgets or failed picks exhaust a healthy route', async () => {
    const f = fixture();
    await f.pick('healthy-warm');
    for (let i = 0; i < 512; i += 1) f.client.forgetGroup(`unrelated-forget-${i}`, 'openai');
    expect(f.client.readConfig('O', 'openai')).toEqual(f.config);

    const original = f.livePick.getMockImplementation()!;
    f.livePick.mockImplementation(async (owner, input) => {
      if (owner !== 'O') throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
      return original(owner, input);
    });
    for (let i = 0; i < 512; i += 1) {
      await expect(f.client.pick(`unrelated-pick-${i}`, { ...f.input, sessionId: `failed-${i}` }))
        .rejects.toThrow('owner offline');
    }
    expect(f.client.readConfig('O', 'openai')).toEqual(f.config);
    f.clock.ownerOnline = false;
    expect(await f.pick('healthy-after-pressure')).toMatchObject({ kind: 'member', member: { agentDeviceId: 'M' } });
    expect(f.bind).toHaveBeenCalledTimes(1);
  });

  it('reports local capacity instead of evicting referenced scopes', async () => {
    const f = fixture();
    for (let i = 0; i < 512; i += 1) {
      await f.client.pick(`full-${i}`, { ...f.input, sessionId: `full-${i}` });
    }
    await expect(f.client.pick('overflow', { ...f.input, sessionId: 'overflow' }))
      .rejects.toBeInstanceOf(ProviderGroupLocalCapacityError);
    expect(f.client.readConfig('full-0', 'openai')).toEqual(f.config);
  });

  // Test value
  // - Production entry: createGroupContinuityClient.pick + real M executor inspect/admission;
  //   only transport and clock/capture inputs are controlled.
  // - Rule: at the 512-row bound, only a genuinely new positive row may reclaim a slot;
  //   an uncapturable online pick or a refresh of an existing key must not evict a
  //   still-valid neighbour.
  // - Gap: followup3 deleted the oldest row before checking peer capture and key existence.
  // - Minimal failing input: 512 warm models, then one uncapturable O2 online pick and one
  //   existing model-1 refresh in the same full table; O offline and model-0 must still admit.
  // - Tier: unit integration (real client/executor; fake transport/metadata capture).
  it('does not evict a neighbour when an uncapturable pick or existing-key refresh needs no new row', async () => {
    const clock = { wall: 0, mono: 0, online: true };
    const configFor = (agentDeviceId: string) => normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true,
      allowFast: false, members: [{ kind: 'device', agentDeviceId, providerId: 'openai' }] }, 'openai')!;
    const oldConfig = configFor('M'), newConfig = configFor('M2');
    const oldMember = oldConfig.members[0], newMember = newConfig.members[0];
    let inspects = 0, admits = 0;
    const executors = new Map<string, ReturnType<typeof createGroupContinuityExecutor>>();
    const executorFor = (memberId: string) => {
      let executor = executors.get(memberId);
      if (!executor) {
        executor = createGroupContinuityExecutor({ capture: () => () => true,
          inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
          wall: () => clock.wall, mono: () => clock.mono });
        executors.set(memberId, executor);
      }
      return executor;
    };
    const livePick: ProviderGroupRemoteClient['pick'] = async (owner, request) => {
      if (!clock.online) throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
      const isNew = owner === 'O2', config = isNew ? newConfig : oldConfig;
      const member = isNew ? newMember : oldMember;
      const grant: GroupContinuityGrant = { id: (isNew ? 'new-' : 'old-') + request.model, group: 'openai',
        controller: 'C', providerId: 'openai', agentKind: 'codex', model: request.model,
        fastPolicyRequired: false, remainingMs: 1_800_000 };
      const ack = await executorFor(member.agentDeviceId!).handle(owner, { action: 'continuity-prepare', grant });
      return parseProviderGroupRemotePick({ kind: 'member', member, label: 'M',
        continuity: { ...ack, config } }, 'openai');
    };
    const invoke: ProviderGroupRemoteInvoke = async (target, _channel, args, options) => {
      options?.preSend?.();
      const action = (args[0] as { action: string }).action;
      if (action === 'continuity-inspect') inspects += 1;
      if (action === 'continuity-admit') admits += 1;
      return { ok: true, result: await executorFor(target).handle('C', args[0]) };
    };
    const client = createGroupContinuityClient({ livePick, invoke,
      capture: (target: string) => () => target !== 'O2',
      scopeKey: () => 'scope:1', ownerMayRespond: () => clock.online,
      retryable: (error: unknown) => (error as { code?: string }).code === 'NOT_CONNECTED',
      wall: () => clock.wall, mono: () => clock.mono });
    const input = (model: string, sessionId: string) => ({ providerId: 'openai', agentKind: 'codex' as const,
      model, exclude: [] as string[], allowOffline: true, sessionId });
    // Both phases share one 512-row warmup. Phase 1 only observes the intact table; phase 2
    // resets the counters, so sharing cannot mask either regression.
    for (let i = 0; i < 512; i += 1) await client.pick('O', input('model-' + i, 'warm-' + i));

    expect(await client.pick('O2', input('new-model', 'new-online'))).toMatchObject({ kind: 'member',
      member: { agentDeviceId: 'M2' } });
    expect(client.readConfig('O2', 'openai')).toBeNull();
    clock.online = false;
    expect(await client.pick('O', input('model-0', 'offline-after-uncapturable'))).toMatchObject({ kind: 'member',
      member: { agentDeviceId: 'M' } });
    expect(inspects).toBe(1);
    expect(admits).toBe(1);

    clock.online = true; inspects = 0; admits = 0;
    expect(await client.pick('O', input('model-1', 'refresh-existing'))).toMatchObject({ kind: 'member' });
    clock.online = false;
    expect(await client.pick('O', input('model-0', 'offline-after-refresh'))).toMatchObject({ kind: 'member',
      member: { agentDeviceId: 'M' } });
    expect(inspects).toBe(1);
    expect(admits).toBe(1);
  });
  it('treats a full provisional table as temporary and keeps the valid context', async () => {
    const f = fixture(); await f.pick();
    for (let i = 0; i < 1024; i += 1) {
      await f.executor.handle('C', { action: 'continuity-admit', id: f.grant.id, ownerDeviceId: 'O', sessionId: `cap-${i}` });
    }
    await expect(f.executor.handle('C', { action: 'continuity-admit', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'overflow' }))
      .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    await expect(f.executor.handle('C', { action: 'continuity-inspect', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'after' }))
      .resolves.toMatchObject({ id: f.grant.id });
    f.clock.wall = f.clock.mono = 30_001;
    await expect(f.executor.handle('C', { action: 'continuity-admit', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'after-release' }))
      .resolves.toMatchObject({ id: f.grant.id });
  });

  it('keeps the acknowledged row when executor admission is temporarily unavailable', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false;
    const normal = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (target, channel, args, options) => {
      if ((args[0] as { action?: string }).action === 'continuity-admit') {
        return { ok: false, error: { code: 'IPC_ERROR', message: '[REMOTE_AGENT_UNAVAILABLE] capacity' } };
      }
      return normal(target, channel, args, options);
    });
    await expect(f.pick('capacity')).rejects.toThrow('NOT_CONNECTED');
    expect(f.client.readConfig('O', 'openai')).toEqual(f.config);
  });

  it('does not resurrect a revoked context when the tombstone table is full', async () => {
    const clock = { wall: 0, mono: 0, current: true };
    const executor = createGroupContinuityExecutor({
      capture: () => () => clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
      wall: () => clock.wall, mono: () => clock.mono,
    });
    const grant: GroupContinuityGrant = { id: 'victim', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let i = 0; i < 512; i += 1) {
        const id = `prepared-${cycle}-${i}`;
        await executor.handle('O', { action: 'continuity-prepare', grant: { ...grant, id } });
        await executor.handle('O', { action: 'continuity-revoke', id });
      }
    }
    await executor.handle('O', { action: 'continuity-prepare', grant });
    await expect(executor.handle('O', { action: 'continuity-revoke', id: grant.id })).resolves.toEqual({ ok: true });
    await expect(executor.handle('O', { action: 'continuity-prepare', grant }))
      .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    // Unit gap: revoke can arrive before its delayed prepare. At full capacity,
    // no positive entry exists yet, but the original explicit revoke still fences it.
    const delayed = { ...grant, id: 'not-yet-prepared', controller: 'C3' };
    await expect(executor.handle('O-late', { action: 'continuity-revoke', id: delayed.id })).resolves.toEqual({ ok: true });
    await expect(executor.handle('O-late', { action: 'continuity-prepare', grant: delayed }))
      .rejects.toThrow(/ACCESS_REVOKED|REMOTE_AGENT_UNAVAILABLE/);
    clock.wall = clock.mono = 1_700_000;
    await expect(executor.handle('O-late', { action: 'continuity-revoke', id: delayed.id })).resolves.toEqual({ ok: true });
    clock.wall = clock.mono = 1_800_000;
    await expect(executor.handle('O-late', { action: 'continuity-prepare', grant: delayed }))
      .resolves.toMatchObject({ id: delayed.id });
    const other = { ...grant, id: 'other', controller: 'C2' };
    await expect(executor.handle('O2', { action: 'continuity-prepare', grant: other }))
      .resolves.toMatchObject({ id: 'other' });
  });

  it('keeps an unexpired closed fence at capacity and uses bounded backpressure', async () => {
    const clock = { wall: 0, mono: 0, current: true };
    const executor = createGroupContinuityExecutor({
      capture: () => () => clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
      wall: () => clock.wall, mono: () => clock.mono,
    });
    const base: GroupContinuityGrant = { id: 'victim', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    const victim = { ...base, id: 'victim' };
    const survivor = { ...base, id: 'survivor' };
    await executor.handle('O', { action: 'continuity-prepare', grant: victim });
    await executor.handle('O', { action: 'continuity-prepare', grant: survivor });
    executor.invalidate(entry => entry.grant.id === victim.id);
    for (let i = 0; i < 4096; i += 1) {
      const id = 'closed-fill-' + i;
      await executor.handle('O', { action: 'continuity-prepare', grant: { ...base, id } });
      executor.invalidate(entry => entry.grant.id === id);
    }
    // The oldest unexpired victim fence must not be evicted by the full table.
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: victim }))
      .rejects.toThrow('ACCESS_REVOKED');
    // A genuinely new grant from the same origin gets bounded temporary busy.
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: { ...base, id: 'fresh' } }))
      .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    // An already-acknowledged survivor is still idempotent and usable.
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: survivor }))
      .resolves.toMatchObject({ id: 'survivor' });
    await expect(executor.handle('C', { action: 'continuity-admit', id: survivor.id,
      ownerDeviceId: 'O', sessionId: 'survivor' })).resolves.toMatchObject({ id: 'survivor' });
    // A neighbor origin is not fenced by another origin's closed table.
    const neighbor = { ...base, id: 'neighbor', controller: 'C2' };
    await expect(executor.handle('O2', { action: 'continuity-prepare', grant: neighbor }))
      .resolves.toMatchObject({ id: 'neighbor' });
    await expect(executor.handle('C2', { action: 'continuity-admit', id: neighbor.id,
      ownerDeviceId: 'O2', sessionId: 'neighbor' })).resolves.toMatchObject({ id: 'neighbor' });
    // After the original window, both the tombstone and the temporary fence expire.
    clock.wall = clock.mono = 1_800_000;
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: victim }))
      .resolves.toMatchObject({ id: 'victim' });
  });

  it('keeps a still-valid survivor prepare idempotent while another grant overflows', async () => {
    const clock = { wall: 0, mono: 0, current: true };
    const executor = createGroupContinuityExecutor({
      capture: () => () => clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
      wall: () => clock.wall, mono: () => clock.mono,
    });
    const base: GroupContinuityGrant = { id: 'base', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let i = 0; i < 512; i += 1) {
        const id = `survivor-fill-${cycle}-${i}`;
        await executor.handle('O', { action: 'continuity-prepare', grant: { ...base, id } });
        await executor.handle('O', { action: 'continuity-revoke', id });
      }
    }
    const survivor = { ...base, id: 'survivor' };
    await executor.handle('O', { action: 'continuity-prepare', grant: survivor });
    clock.wall = clock.mono = 100;
    const victim = { ...base, id: 'victim' };
    await executor.handle('O', { action: 'continuity-prepare', grant: victim });
    await executor.handle('O', { action: 'continuity-revoke', id: victim.id });
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: survivor }))
      .resolves.toMatchObject({ id: 'survivor', remainingMs: 1_799_900 });
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: { ...survivor, model: 'other' } }))
      .rejects.toThrow('ACCESS_REVOKED');
    await expect(executor.handle('C', { action: 'continuity-inspect', id: survivor.id,
      ownerDeviceId: 'O', sessionId: 'survivor-task' })).resolves.toMatchObject({ id: 'survivor' });
    await expect(executor.handle('C', { action: 'continuity-admit', id: survivor.id,
      ownerDeviceId: 'O', sessionId: 'survivor-task' })).resolves.toMatchObject({ id: 'survivor' });
  });

  it('preserves per-origin overflow deadlines when global overflow is installed', async () => {
    const clock = { wall: 1_000_000_000, mono: 0, current: true };
    const executor = createGroupContinuityExecutor({
      capture: () => () => clock.current,
      inspect: async () => ({ running: 0, fastPolicyRequired: false }), bindFast: async () => {},
      wall: () => clock.wall, mono: () => clock.mono,
    });
    const base: GroupContinuityGrant = { id: 'base', group: 'openai', controller: 'C',
      providerId: 'openai', agentKind: 'codex', model: 'model', fastPolicyRequired: false, remainingMs: 1_800_000 };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let i = 0; i < 512; i += 1) {
        const id = `global-fill-${cycle}-${i}`;
        await executor.handle('O', { action: 'continuity-prepare', grant: { ...base, id } });
        await executor.handle('O', { action: 'continuity-revoke', id });
      }
    }
    const otherSurvivor = { ...base, id: 'other-survivor', controller: 'C2' };
    await executor.handle('O2', { action: 'continuity-prepare', grant: otherSurvivor });
    const victim = { ...base, id: 'victim' };
    await executor.handle('O', { action: 'continuity-prepare', grant: victim });
    await executor.handle('O', { action: 'continuity-revoke', id: victim.id });
    clock.wall = 0; clock.mono = 1;
    for (let i = 0; i < 256; i += 1) {
      const origin = `O-${i}`;
      const grant = { ...base, id: `origin-fill-${i}`, controller: `C-${i}` };
      await executor.handle(origin, { action: 'continuity-prepare', grant });
      await executor.handle(origin, { action: 'continuity-revoke', id: grant.id });
    }
    clock.wall = 1_800_000; clock.mono = 2;
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: victim }))
      .rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    await expect(executor.handle('C2', { action: 'continuity-inspect', id: otherSurvivor.id,
      ownerDeviceId: 'O2', sessionId: 'other-task' })).resolves.toMatchObject({ id: 'other-survivor' });
    clock.wall = 1_500_000; clock.mono = 1_500_000;
    await expect(executor.handle('O', { action: 'continuity-revoke', id: victim.id })).resolves.toEqual({ ok: true });
    clock.wall = 1_001_800_000; clock.mono = 2;
    await expect(executor.handle('O', { action: 'continuity-prepare', grant: victim }))
      .resolves.toMatchObject({ id: 'victim' });
  });
});
