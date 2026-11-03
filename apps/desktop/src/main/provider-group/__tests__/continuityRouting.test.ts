/** Unit: real group pick/client + M admission; only transport/local provider I/O is replaced.
 * Gap: an O outage previously blocked a new same-account task despite a healthy C↔M path.
 * Minimal input: one acknowledged route, O offline, then a distinct task. No paid/native invocation. */
import { describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer } from '@cindy/device-link';
import { normalizeProviderGroupConfig, parseProviderGroupRemotePick } from '../../../shared/providerGroup.js';
import type { GroupContinuityGrant } from '../../../shared/providerGroupContinuity.js';
import { createGroupContinuityExecutor } from '../continuityExecutor.js';
import { createGroupContinuityClient } from '../continuityClient.js';
import type { ProviderGroupRemoteClient } from '../remoteClient.js';

function fixture() {
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
    members: [{ kind: 'device', agentDeviceId: 'M', providerId: 'openai' }] }, 'openai')!;
  const member = config.members[0];
  const grant: GroupContinuityGrant = { id: 'grant-1', group: 'openai', controller: 'C', providerId: 'openai',
    agentKind: 'codex', model: 'model', fastPolicyRequired: true, remainingMs: 1_800_000 };
  const livePick = vi.fn<ProviderGroupRemoteClient['pick']>(async () => {
    if (!clock.ownerOnline) throw Object.assign(new Error('owner offline'), { code: 'NOT_CONNECTED' });
    const ack = await executor.handle('O', { action: 'continuity-prepare', grant });
    return parseProviderGroupRemotePick({ kind: 'member', member, label: 'M',
      continuity: { ...ack, config } }, 'openai');
  });
  const invoke = vi.fn(async (_target: string, _channel: string, args: unknown[], options?: { preSend?: () => void }) => {
    options?.preSend?.(); return { ok: true, result: await executor.handle('C', args[0]) };
  });
  const client = createGroupContinuityClient({ livePick, invoke, capture: () => {
    const generation = clock.generation; return () => clock.current && clock.generation === generation;
  },
    ownerMayRespond: () => clock.ownerOnline, retryable: error => (error as { code?: string }).code === 'NOT_CONNECTED',
    wall: () => clock.wall, mono: () => clock.mono });
  const input = { providerId: 'openai', agentKind: 'codex' as const, model: 'model', exclude: [] as string[] };
  return { clock, executor, config, grant, client, bind, inspect, invoke, livePick, input,
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

  it('uses current M load for concurrent admissions and does not reinterpret the group soft limit as a rejection', async () => {
    const f = fixture(); await f.pick(); f.clock.ownerOnline = false; f.clock.running = 99;
    await Promise.all([f.pick('A'), f.pick('B')]);
    expect(f.bind.mock.calls.map(call => call[2]).sort()).toEqual(['A', 'B']);
    const ack = await f.executor.handle('C', { action: 'continuity-inspect', id: f.grant.id, ownerDeviceId: 'O', sessionId: 'C' });
    expect(ack).toMatchObject({ running: 101 });
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
});
