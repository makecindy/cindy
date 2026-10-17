/**
 * 供应商组的转分享(组所在电脑这一边，provider-sharing.md §4.3)：组里有分享来的电脑、组所在的供应商又分享给了别人时，
 * 把分享的人整体报给那台，按那台回来的结果决定能不能分给这个人；没问到之前一律当作没同意。
 */
import type { ProviderShareOwned, RemoteAgentCaps } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { reshareKeyFor } from '../../remote-agent/host/groupRelay';
import { createProviderGroupReshare, PROVIDER_GROUP_RESHARE_IDLE_POLL_MS, PROVIDER_GROUP_RESHARE_PENDING_POLL_MS, type ProviderGroupReshare } from '../reshare';

const instances: ProviderGroupReshare[] = [];

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const FRIEND = member('share:a1:anthropic', 'share', 'share:a1');
const MINI = member('device:mini:anthropic', 'device', 'mini');

function owned(members: Array<{ memberId: string; displayName: string }>, providerId = 'anthropic'): ProviderShareOwned {
  return {
    shareId: 'b-share',
    providerId,
    providerLabel: 'Anthropic',
    hostDeviceId: 'b-device',
    createdAt: '2026-10-15T00:00:00.000Z',
    members: members.map((m) => ({
      ...m,
      avatarUrl: null,
      region: 'global',
      status: 'active',
      joinedAt: '2026-10-15T00:00:00.000Z',
    })),
    requests: [],
  };
}

const CAPS: RemoteAgentCaps = {
  version: 1,
  agents: [],
  maxRuns: 16,
  uploadChunkBytes: 1024,
  maxPayloadBytes: 2048,
  reshareConsent: true,
  reshareBatch: true,
};
const CAROL = reshareKeyFor('b-share', 'carol');
const DAVE = reshareKeyFor('b-share', 'dave');

function setup(options: {
  groups?: Record<string, ProviderGroupConfig>;
  shares?: ProviderShareOwned[] | null;
  caps?: RemoteAgentCaps;
  states?: Record<string, 'pending' | 'approved' | 'rejected'>;
} = {}) {
  let now = 1_000;
  let groups = options.groups ?? { anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, FRIEND, MINI] } };
  let shares: ProviderShareOwned[] | null = options.shares === undefined
    ? [owned([{ memberId: 'carol', displayName: 'Carol' }, { memberId: 'dave', displayName: 'Dave' }])]
    : options.shares;
  let states = { ...(options.states ?? {}) };
  const responses: unknown[] = [];
  const cleanups: Record<string, string> = {};
  let cleanupSeq = 0;
  const invoke = vi.fn(async (_agentDeviceId: string, request: unknown) => {
    const input = request as { entries: Array<{ key: string }>; batch?: { id: string; index: number; count: number } };
    const entries = input.entries;
    if (entries.length === 0) states = {};
    const response = {
      entries: entries.map((entry) => ({ key: entry.key, state: states[entry.key] ?? 'pending' as const })),
      ...(input.batch ? { batch: { ...input.batch, complete: input.batch.index === input.batch.count - 1 } } : {}),
    };
    responses.push(response);
    return response;
  });
  const readCaps = vi.fn(async () => options.caps ?? CAPS);
  const changed = vi.fn();
  const completeCleanup = vi.fn(async (device: string, token: string) => {
    if (cleanups[device] === token) delete cleanups[device];
  });
  const deps = {
    listGroups: () => groups,
    ownedShares: () => shares,
    pendingCleanups: () => cleanups,
    completeCleanup,
    readCaps,
    invoke,
    changed,
    now: () => now,
    log: { warn: vi.fn() },
  };
  let reshare = createProviderGroupReshare(deps);
  instances.push(reshare);
  return {
    get reshare() { return reshare; },
    invoke,
    responses,
    readCaps,
    changed,
    completeCleanup,
    cleanups,
    setGroups: (next: Record<string, ProviderGroupConfig>) => {
      // 生产中由 writeProviderGroup 与移出组同一事务持久记下(真实落盘回归在 stores.test.ts)。
      const shared = (configs: Record<string, ProviderGroupConfig>) => new Set(Object.values(configs)
        .flatMap((config) => config.members.filter((m) => m.kind === 'share').map((m) => m.agentDeviceId!)));
      const remaining = shared(next);
      for (const device of shared(groups)) if (!remaining.has(device)) cleanups[device] = `cleanup-${++cleanupSeq}`;
      groups = next;
    },
    restart: () => {
      reshare.stop();
      reshare = createProviderGroupReshare(deps);
      instances.push(reshare);
    },
    setShares: (next: ProviderShareOwned[] | null) => { shares = next; },
    setStates: (next: Record<string, 'pending' | 'approved' | 'rejected'>) => { states = { ...next }; },
    advance: (ms: number) => { now += ms; },
  };
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});

describe('provider group reshare (group computer side)', () => {
  it('reports the people this computer shares the group with only to shared-in computers, and follows their answers', async () => {
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'pending' } });
    // 没问到之前一律当作没同意。
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    expect(env.invoke).toHaveBeenCalledWith('share:a1', {
      op: 'reshare',
      entries: [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }],
    });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
    expect(env.reshare.allows('share:a1', DAVE)).toBe(false);
    expect(env.reshare.allows('share:a1', undefined)).toBe(false);
    // 同账号电脑与本机不需要同意，也不会被问。
    expect(env.invoke.mock.calls.some(([id]) => id === 'mini')).toBe(false);
    expect(env.reshare.summary('anthropic', 'share:a1')).toEqual({
      support: 'supported',
      guests: [
        { memberId: 'carol', displayName: 'Carol', avatarUrl: null, state: 'approved' },
        { memberId: 'dave', displayName: 'Dave', avatarUrl: null, state: 'pending' },
      ],
    });
    expect(env.changed).toHaveBeenCalled();
  });

  it('does not report anything before this computer has read whom it shares with (an empty list would wipe consents)', async () => {
    const env = setup({ shares: null });
    await env.reshare.sync('test');
    expect(env.invoke).not.toHaveBeenCalled();
    expect(env.reshare.summary('anthropic', 'share:a1')).toBeNull();
  });

  it('treats an older shared-in computer as unable to agree', async () => {
    const env = setup({ caps: { ...CAPS, reshareConsent: undefined } });
    await env.reshare.sync('test');
    expect(env.invoke).not.toHaveBeenCalled();
    expect(env.reshare.needsUpdate('share:a1')).toBe(true);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    expect(env.reshare.summary('anthropic', 'share:a1')?.support).toBe('needs-update');
  });

  it('sends a large report in ordered batches and aggregates the final states', async () => {
    const members = Array.from({ length: 257 }, (_, index) => ({ memberId: 'member-' + index, displayName: 'Member ' + index }));
    const approvedKey = reshareKeyFor('b-share', 'member-0');
    const env = setup({ shares: [owned(members)], states: { [approvedKey]: 'approved' } });
    await env.reshare.sync('large');

    expect(env.invoke).toHaveBeenCalledTimes(2);
    const requests = env.invoke.mock.calls.map(([, request]) => request as { op: string; entries: unknown[]; batch?: { id: string; index: number; count: number } });
    expect(requests.map((request) => request.entries.length)).toEqual([256, 1]);
    expect(requests.map((request) => request.batch?.index)).toEqual([0, 1]);
    expect(requests[0]?.batch?.id).toBe(requests[1]?.batch?.id);
    expect(requests.every((request) => request.batch?.count === 2)).toBe(true);
    expect(env.responses).toEqual([
      expect.objectContaining({ batch: expect.objectContaining({ index: 0, count: 2, complete: false }) }),
      expect.objectContaining({ batch: expect.objectContaining({ index: 1, count: 2, complete: true }) }),
    ]);
    expect(env.reshare.summary('anthropic', 'share:a1')?.guests).toHaveLength(257);
    expect(env.reshare.allows('share:a1', approvedKey)).toBe(true);
    expect(env.reshare.summary('anthropic', 'share:a1')?.guests.at(-1)?.state).toBe('pending');
  });

  it('does not partially send a large report to an older computer', async () => {
    const members = Array.from({ length: 257 }, (_, index) => ({ memberId: 'member-' + index, displayName: 'Member ' + index }));
    const env = setup({ shares: [owned(members)], caps: { ...CAPS, reshareBatch: undefined } });
    await env.reshare.sync('old');
    expect(env.invoke).not.toHaveBeenCalled();
    expect(env.reshare.needsUpdate('share:a1')).toBe(true);
  });

  it('keeps the last answers when the shared-in computer cannot be reached, and asks again later', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.readCaps.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('test', { force: true });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
  });

  it('only asks again when the people change or the check interval passes, unless forced', async () => {
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'approved' } });
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    await env.reshare.sync('poll');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    env.setShares([owned([{ memberId: 'carol', displayName: 'Carol' }])]);
    await env.reshare.sync('owned');
    expect(env.invoke).toHaveBeenCalledTimes(2);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [{ key: CAROL, name: 'Carol' }] });
    await env.reshare.sync('view', { force: true });
    expect(env.invoke).toHaveBeenCalledTimes(3);
  });

  it('tells a computer that left every group to drop the people it was told about', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.setGroups({ anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] } });
    await env.reshare.sync('group');
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
  });

  it('retries an offline cleanup until confirmed without letting that computer reuse its approval', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    env.setGroups({});
    // 移出当下就拦住缓存里的同意，不等 debounce 或远端回包。
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    env.invoke.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('removed');
    expect(env.cleanups['share:a1']).toBeDefined();
    expect(env.completeCleanup).not.toHaveBeenCalled();
    env.advance(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    expect(env.invoke).toHaveBeenCalledTimes(3);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.cleanups).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes persisted cleanup after restart even before the owned share snapshot is available', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    env.setGroups({});
    env.invoke.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('removed');
    env.restart();
    env.setShares(null);
    await env.reshare.sync('startup');
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.cleanups).toEqual({});
  });

  it('clears old consent before reporting people after the same shared computer rejoins', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    env.setGroups({});
    env.invoke.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('removed');
    env.setGroups({ anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, FRIEND] } });
    env.restart();
    await env.reshare.sync('rejoined');
    expect(env.invoke.mock.calls.slice(2).map(([, request]) => request)).toEqual([
      { op: 'reshare', entries: [] },
      { op: 'reshare', entries: [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }] },
    ]);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    expect(env.reshare.summary('anthropic', 'share:a1')?.guests[0].state).toBe('pending');
  });

  it('keeps a cleanup while the shared computer is downgraded and cannot confirm clearing its records', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    env.setGroups({});
    env.readCaps.mockResolvedValueOnce({ ...CAPS, reshareConsent: undefined });
    await env.reshare.sync('removed');
    expect(env.completeCleanup).not.toHaveBeenCalled();
    expect(env.cleanups['share:a1']).toBeDefined();
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
  });

  it('retains cleanup when the remote clear succeeds but saving its acknowledgement fails', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    env.setGroups({});
    env.completeCleanup.mockRejectedValueOnce(new Error('disk busy'));
    await env.reshare.sync('removed');
    expect(env.cleanups['share:a1']).toBeDefined();
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    env.advance(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    expect(env.completeCleanup).toHaveBeenCalledTimes(2);
    expect(env.cleanups).toEqual({});
  });

  it('does not send a stale report or restore consent when the computer leaves during capability lookup', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('initial');
    let release!: () => void;
    env.readCaps.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(CAPS); }));
    const reporting = env.reshare.sync('view', { force: true });
    env.setGroups({});
    release();
    await reporting;
    expect(env.invoke).toHaveBeenCalledTimes(1);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.cleanups).toEqual({});
  });

  it('forgets an approval right away when the shared-in computer refuses the person, then re-checks', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.setStates({ [CAROL]: 'rejected' });
    env.reshare.noteDenied('share:a1', CAROL);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    await vi.waitFor(() => expect(env.invoke).toHaveBeenCalledTimes(2));
    await env.reshare.sync('test');
    expect(env.reshare.summary('anthropic', 'share:a1')?.guests[0]?.state).toBe('rejected');
  });

  it('polls every minute while someone is still waiting', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'pending' } });
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    env.setStates({ [CAROL]: 'approved' });
    env.advance(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    expect(env.invoke).toHaveBeenCalledTimes(2);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
    env.reshare.stop();
  });

  it('does not lose a change that arrives while a report is in flight', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'approved' } });
    let release!: () => void;
    env.readCaps.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(CAPS); }));
    const first = env.reshare.sync('test');
    // 报告进行中又有人变了：合并的报告不能被报告结束时重排的定时核对吞掉。
    env.setShares([owned([{ memberId: 'carol', displayName: 'Carol' }])]);
    env.reshare.kick('owned');
    release();
    await first;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [{ key: CAROL, name: 'Carol' }] });
    env.reshare.stop();
  });

  it('shows nothing when this computer shares the provider with nobody', async () => {
    const env = setup({ shares: [] });
    await env.reshare.sync('test');
    // 没有分享的人也报一份空的：清掉那台上可能留着的旧请求。
    expect(env.invoke).toHaveBeenCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.reshare.summary('anthropic', 'share:a1')).toBeNull();
  });

  it('does not poll a confirmed empty list after ten minutes', async () => {
    vi.useFakeTimers();
    const env = setup({ shares: [] });
    await env.reshare.sync('initial');
    expect(vi.getTimerCount()).toBe(0);
    env.advance(PROVIDER_GROUP_RESHARE_IDLE_POLL_MS * 2);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_IDLE_POLL_MS * 2);
    expect(env.invoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries an empty list that failed, even if an earlier empty list succeeded', async () => {
    vi.useFakeTimers();
    const env = setup({ shares: [] });
    await env.reshare.sync('initial');
    env.invoke.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('view', { force: true });
    expect(vi.getTimerCount()).toBe(1);
    env.advance(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    expect(env.invoke).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
