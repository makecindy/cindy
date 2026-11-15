/**
 * Regression: an application picked back onto its caller must remain busy after the
 * group's 30s provisional lease and 150s report TTL. One shared snapshot preserves
 * ordinary task leases; completion/close releases load. Fake time, no account or model.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import { createLocalAgentLoadRegistry } from '../load.js';
import { createLocalAgentGroupRouteResolver, localAgentResumeId, readLocalAgentResumeId } from '../groupRoute.js';
import { createProviderGroupRemoteClient } from '../../provider-group/remoteClient.js';
import { createProviderGroupLeaseReporter } from '../../provider-group/leaseReporter.js';
import { createProviderGroupExternalLoad } from '../../provider-group/externalLoad.js';
import { countProviderRunningTurns } from '../../provider-group/localLoad.js';
import { createProviderGroupRouter } from '../../provider-group/router.js';
import type { ProviderGroupDirectory } from '../../provider-group/directory.js';
import type { ProviderGroupMember } from '../../../shared/providerGroup.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function session() {
  let running = false;
  const events = new Set<Parameters<Session['onEvent']>[0]>();
  const statuses = new Set<Parameters<Session['onStatusChange']>[0]>();
  return {
    isTurnRunning: () => running,
    onEvent: (listener: Parameters<Session['onEvent']>[0]) => { events.add(listener); return () => { events.delete(listener); }; },
    onStatusChange: (listener: Parameters<Session['onStatusChange']>[0]) => { statuses.add(listener); return () => { statuses.delete(listener); }; },
    turn(value: boolean) {
      running = value;
      for (const listener of events) listener({ type: 'done' } as Parameters<typeof listener>[0]);
    },
    close() { for (const listener of statuses) listener('closed'); },
    listenerCount: () => events.size + statuses.size,
  };
}

it('keeps local application and ordinary leases in one snapshot through heartbeats and subsequent allocation', async () => {
  const self = 'a'.repeat(64), owner = 'b'.repeat(64);
  const external = createProviderGroupExternalLoad({ now: () => Date.now() });
  const load = createLocalAgentLoadRegistry();
  const native = session();
  const resolver = createLocalAgentGroupRouteResolver({
    remote: createProviderGroupRemoteClient(async () => ({ ok: true, result: {
      kind: 'member', member: { kind: 'device', agentDeviceId: self, providerId: 'member' }, label: 'A',
    } })), localDeviceId: () => self, assertCurrent: () => {},
  });
  const route = await resolver({ sessionId: 'app', agentKind: 'codex', model: 'model', providerId: 'group', agentDeviceId: owner });
  expect(route.agentDeviceId).toBeUndefined();
  const key = route.groupBinding!.memberKey;
  expect(route.groupBinding).toEqual({ providerId: 'group', memberKey: `device:${self}:member`, groupDeviceId: owner });
  expect(readLocalAgentResumeId(localAgentResumeId('native', route)).route).toEqual(route);
  external.recordPick(self, 'app', 'group', key);
  let ordinaryRunning = true;
  const send = vi.fn(async (_owner: string, seq: number, entries: Parameters<typeof external.replaceLeases>[2]) => {
    external.replaceLeases(self, seq, entries);
  });
  const reporter = createProviderGroupLeaseReporter({
    listRemoteBindings: () => ({ ordinary: { providerId: 'other', memberKey: 'local', groupDeviceId: owner, at: 0 }, ...load.bindings() }),
    isTurnRunning: id => id === 'ordinary' ? ordinaryRunning : load.isTurnRunning(id),
    send, now: () => Date.now(), log: { warn: vi.fn() },
  });
  const unsubscribe = load.subscribe(id => reporter.notify(id));
  try {
    load.track('app', route, native);
    native.turn(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(external.running('group', key)).toBe(1);
    expect(external.running('other', 'local')).toBe(1);
    // Continuous output cannot reset the heartbeat indefinitely.
    for (let second = 0; second < 180; second++) {
      native.turn(true);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(external.running('group', key)).toBe(1);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(4);
    const members: ProviderGroupMember[] = [
      { key, kind: 'device', agentDeviceId: self, providerId: 'member', limit: 1, weight: 1, paused: false },
      { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'group', limit: 1, weight: 1, paused: false },
    ];
    const directory: ProviderGroupDirectory = {
      resolveMembers: async () => members.map(member => ({ member, label: member.key, state: 'ok' as const,
        view: { id: member.providerId, name: member.providerId, source: 'user', auth: { method: 'apiKey' },
          routing: {}, connected: true, agents: ['codex'],
          models: { codex: [{ id: 'model', name: 'model', contextWindow: 200_000, efforts: [], defaultEffort: null }] } },
      })),
      listCandidates: async () => [], readDeviceCatalog: async () => [], probe: async () => 'ok',
      memberLabel: (member: ProviderGroupMember) => member.key, invalidate: () => {},
    };
    const router = createProviderGroupRouter({ directory,
      readGroup: () => ({ strategy: 'least', autoSwitch: true, members }),
      listBindings: () => ({}), isTurnRunning: () => false,
      externalRunning: (provider, member) => external.running(provider, member),
      now: () => Date.now(), random: () => 0,
    });
    const next = await router.pick({ providerId: 'group', agentKind: 'codex', model: 'model' });
    expect(next.kind).toBe('member');
    if (next.kind === 'member') expect(next.member.key).toBe('local');
    const counts = () => countProviderRunningTurns({
      listTurnRunningSessions: () => [], readSessionRoutes: async () => [], resolveImplicitProvider: async () => null,
      hostRunningProviders: () => [], applicationRunningProviders: () => load.runningProviders(),
    });
    expect(Object.fromEntries(await counts())).toEqual({ member: 1 });
    native.turn(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(external.running('group', key)).toBe(0);
    expect(external.running('other', 'local')).toBe(1);
    expect((await counts()).size).toBe(0);
    native.turn(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(external.running('group', key)).toBe(1);
    native.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(external.running('group', key)).toBe(0);
    expect(load.bindings()).toEqual({});
    expect(load.runningProviders()).toEqual([]);
    expect(native.listenerCount()).toBe(0);
    ordinaryRunning = false;
    reporter.notify('ordinary');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send.mock.calls.at(-1)?.[2]).toEqual([]);
  } finally { unsubscribe(); reporter.dispose(); }
});

it('counts only local execution and isolates owner registries and replacement handles', () => {
  const oldOwner = createLocalAgentLoadRegistry(), newOwner = createLocalAgentLoadRegistry();
  const old = session(), replacement = session(), remote = session(), direct = session();
  oldOwner.track('app', { providerId: 'p' }, old);
  old.turn(true);
  oldOwner.track('app', { providerId: 'p' }, replacement);
  replacement.turn(true);
  old.close();
  oldOwner.track('remote', { providerId: 'p', agentDeviceId: 'remote' }, remote);
  remote.turn(true);
  oldOwner.track('direct', { providerId: 'p' }, direct);
  direct.turn(true);
  expect(old.listenerCount()).toBe(0);
  expect(oldOwner.runningProviders()).toEqual(['p', 'p']);
  expect(newOwner.runningProviders()).toEqual([]);
  expect(newOwner.bindings()).toEqual({});
  replacement.close(); remote.close(); direct.close();
  expect(oldOwner.runningProviders()).toEqual([]);
});
