import { describe, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_LIST_CHANNEL } from '@cindy/device-link';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { publishHomeTaskSnapshot, readTeammateTasks } from '@/session/readTeammateTasks';
import { createHomeListFreshness } from '@/session/homeListFreshness';
import { normalizeTaskTeammateSelection, taskTeammateKey, taskTeammateOptions } from '@/session/teammateTaskSource';
import type { RemoteSession } from '@/session/types';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

// Unit: missing mobile attribution/old-host lanes. Exercise the real reader and batch
// transport with one ordinary task, canonical chat, routine and channel; no timers.
const task = (id: string, patch: Partial<RemoteSession> = {}) => ({ id, title: id, status: 'active', source: 'cc', ...patch } as RemoteSession);
const bot = (id = 'cindy-default') => ({ ref: { collectionId: 'teammates', kind: 'bot', id },
  revision: '1', display: { title: 'Cindy', avatar: { kind: 'asset', value: 'cindy://avatar/preset/cindy', fallbackText: 'C' } },
  links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'canonical' } },
    { rel: 'following', target: { kind: 'session', sessionId: 'followed' } }] });
const input = { deviceId: 'mac', deviceName: 'Mac', scope: 'owner/mac', status: 'all', limit: 200, current: () => true };

describe('mobile teammate task list', () => {
  it('loads old-host lanes across pages, keeps exact ownership and marks archived delegated tasks', async () => {
    const routine = task('routine', { source: 'bot', companion: { id: 'cindy-default', role: 'routine' } });
    const channel = task('channel', { source: 'bot', companion: { id: 'cindy-default', role: 'channel' } });
    const invoke = vi.fn(async (_device: string, api: string, args: any[]) => {
      if (api === 'local-db:history:query') return args[0].args.cursor
        ? { ok: true, sessions: [channel] }
        : { ok: true, sessions: [routine, task('canonical', { source: 'bot', companion: { id: 'cindy-default', role: 'canonical' } })], hasMore: true, nextCursor: 'page2' };
      if (api === 'local-db:sessions:get-many') return args[0].map((id: string) => task(id, { source: 'bot' }));
      if (api === REMOTE_RESOURCE_LIST_CHANNEL) return { collectionId: 'teammates', items: [bot()] };
      if (api === 'maker:bot-delegations:list') return { ok: true, delegations: [
        { requestingBotId: 'cindy-default', childSessionId: 'created' },
        { requestingBotId: 'other', childSessionId: 'followed' },
      ] };
      throw new Error(api);
    });
    const rows = await readTeammateTasks({ ...input, invoke: invoke as RemoteInvoke,
      sessions: [task('created', { status: 'archived' }), task('followed')] });
    expect(rows.map(row => row.id)).toEqual(['created', 'followed', 'routine', 'channel']);
    expect(rows.filter(row => row.taskTeammate).map(row => row.id)).toEqual(['created', 'routine', 'channel']);
    expect(rows[0].taskTeammate?.avatar?.value).toBe('cindy://avatar/preset/cindy');
    expect(invoke.mock.calls.filter(call => call[1] === 'local-db:sessions:get-many')).toHaveLength(1);
    expect(invoke.mock.calls.find(call => call[1] === 'maker:bot-delegations:list')?.[2]).toEqual(['canonical']);
  });

  it('preserves cached host attribution on optional failure, but clears successful removal', async () => {
    const previous = [task('created', { deviceLinkDeviceId: 'mac', taskTeammate: { id: 'cindy-default', name: 'Cindy' } }),
      task('lane', { deviceLinkDeviceId: 'mac', source: 'bot', companion: { id: 'cindy-default', role: 'channel' } })];
    const failed = vi.fn(async () => { throw new Error('CHANNEL_NOT_ALLOWED'); });
    const retained = await readTeammateTasks({ ...input, invoke: failed as RemoteInvoke, sessions: [task('created')], previous });
    expect(retained.map(row => row.id)).toEqual(['created', 'lane']);
    expect(retained[0].taskTeammate?.id).toBe('cindy-default');
    const empty = vi.fn(async (_device: string, api: string) => api === 'local-db:history:query'
      ? { ok: true, sessions: [] } : { collectionId: 'teammates', items: [] });
    const cleared = await readTeammateTasks({ ...input, invoke: empty as RemoteInvoke, sessions: [task('created')], previous });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].taskTeammate).toBeNull();
  });

  it('stops after account/query invalidation and propagates access revocation', async () => {
    let current = true;
    const stale = vi.fn(async () => { current = false; return { ok: true, sessions: [] }; });
    expect(await readTeammateTasks({ ...input, invoke: stale as RemoteInvoke, sessions: [task('normal')], current: () => current })).toEqual([]);
    expect(stale).toHaveBeenCalledTimes(1);
    const revoked = vi.fn(async () => { throw new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'); });
    await expect(readTeammateTasks({ ...input, invoke: revoked as RemoteInvoke, sessions: [] })).rejects.toThrow('REVOKED');
  });

  it('merges cloud and preset Cindy devices without conflating unrelated names', () => {
    const rows = ['mac', 'mbp'].map(deviceId => ({ key: deviceId, host: { deviceId, deviceName: deviceId }, item: bot('cloud-cindy') } as HostedRemoteCollectionItem));
    const cloud = new Set(['cloud-cindy']);
    const options = taskTeammateOptions(rows, cloud, 'en');
    expect(options).toEqual([{ key: taskTeammateKey('cloud-cindy', 'mac', cloud), title: 'Cindy' }]);
    expect(taskTeammateKey('cloud-cindy', 'mac', cloud)).toBe(taskTeammateKey('cloud-cindy', 'mbp', cloud));
    expect(taskTeammateKey('cindy-default', 'mac', cloud)).toBe(taskTeammateKey('cindy-default', 'mbp', cloud));
    expect(taskTeammateOptions(rows, new Set(), 'en')).toHaveLength(2);
    const selections = rows.map(row => taskTeammateKey(row.item.ref.id, row.host.deviceId, new Set()));
    expect(normalizeTaskTeammateSelection(selections, cloud)).toEqual([options[0].key]);
    const cindyIds = new Set(['cloud-cindy', 'other-cindy']);
    expect(normalizeTaskTeammateSelection([...selections, taskTeammateKey('other-cindy', 'other', cloud)], cloud, cindyIds))
      .toEqual([JSON.stringify(['teammate', 'cindy'])]);
    expect(taskTeammateOptions(rows, cloud, 'en', cindyIds)[0].key).toBe(JSON.stringify(['teammate', 'cindy']));
  });
});

// Unit / review4390134794: one ordinary task + a cached channel + a pending
// history response. The production callback must publish without awaiting it.
it('publishes ordinary rows and cached lane ownership before optional history completes', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const lane = task('lane', { deviceLinkDeviceId: 'mac', source: 'bot', companion: { id: 'cindy-default', role: 'channel' } });
  const owned = task('ordinary', { deviceLinkDeviceId: 'mac', taskTeammate: { id: 'cindy-default', name: 'Cindy' } });
  const publishInitial = vi.fn();
  const invoke = vi.fn(async (_device: string, api: string) => api === 'local-db:history:query'
    ? pending : { collectionId: 'teammates', items: [] });
  const reading = readTeammateTasks({ ...input, invoke: invoke as RemoteInvoke, sessions: [task('ordinary')], previous: [owned, lane], publishInitial });
  const initial = publishInitial.mock.calls[0]?.[0];
  finish({ ok: true, sessions: [] });
  await reading;
  expect(initial?.map((row: RemoteSession) => row.id)).toEqual(['ordinary', 'lane']);
  expect(initial?.[0].taskTeammate?.id).toBe('cindy-default');
});

// Unit regression: five bot delegation reads used to serialize; deferred replies
// prove bounded overlap and preserve attribution rather than only counting calls.
it('reads delegations in a bounded parallel batch and applies every creator', async () => {
  const releases: Array<() => void> = [];
  let active = 0, peak = 0;
  const invoke = vi.fn(async (_device: string, api: string, args: string[]) => {
    if (api === 'local-db:history:query') return { ok: true, sessions: [] };
    if (api === REMOTE_RESOURCE_LIST_CHANNEL) return { collectionId: 'teammates', items:
      Array.from({ length: 5 }, (_, i) => ({ ...bot(`bot${i}`), links: [
        { rel: 'conversation', target: { kind: 'session', sessionId: `bot${i}` } },
      ] })) };
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return { ok: true, delegations: [{ requestingBotId: args[0], childSessionId: args[0] }] };
  });
  const reading = readTeammateTasks({ ...input, invoke: invoke as RemoteInvoke,
    sessions: Array.from({ length: 5 }, (_, i) => task(`bot${i}`)) });
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  releases.splice(0).forEach(resolve => resolve());
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases.splice(0).forEach(resolve => resolve());
  const rows = await reading;
  expect(peak).toBe(3);
  expect(rows.map(row => row.taskTeammate?.id)).toEqual(['bot0', 'bot1', 'bot2', 'bot3', 'bot4']);
});

// Unit / foreground resume: the former awaited enrichment kept Home unready.
// One pending history read must not delay publication + readiness; a later push
// invalidates the optional response instead of rolling back the visible task.
it('makes Home ready before teammate history finishes and fences its late result', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  let current = true;
  const publish = vi.fn(), ready = vi.fn();
  const invoke = vi.fn(async () => pending);
  const reading = publishHomeTaskSnapshot({ ...input, invoke: invoke as RemoteInvoke,
    sessions: [task('ordinary')], current: () => current, publish, onReady: ready });
  expect(publish.mock.calls[0][0].map((row: RemoteSession) => row.id)).toEqual(['ordinary']);
  expect(ready).toHaveBeenCalledOnce();
  current = false;
  finish({ ok: true, sessions: [] });
  await reading;
  expect(publish).toHaveBeenCalledOnce();
});

// Review regression (unit): blur/push discarded optional history after the list
// had become fresh. Pending history + invalidation must make the next Home visit refill.
it.each([true, false])('retains refill intent when enrichment is discarded (list fresh first=%s)', async freshFirst => {
  const freshness = createHomeListFreshness();
  const token = freshness.capture('mac');
  let current = true;
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const reading = publishHomeTaskSnapshot({ ...input, invoke: (async () => pending) as RemoteInvoke,
    sessions: [task('ordinary')], current: () => current, publish: () => {}, onReady: () => {},
    onDiscard: () => freshness.invalidate('mac') });
  if (freshFirst) freshness.markFresh('mac', token);
  current = false; // Home blurred or a list mutation superseded this snapshot.
  finish({ ok: true, sessions: [] });
  await reading;
  if (!freshFirst) freshness.markFresh('mac', token);
  expect(freshness.isFresh('mac')).toBe(false);
});

it('stops queued delegation reads after access is revoked', async () => {
  const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const invoke = vi.fn(async (_device: string, api: string) => {
    if (api === 'local-db:history:query') return { ok: true, sessions: [] };
    if (api === REMOTE_RESOURCE_LIST_CHANNEL) return { collectionId: 'teammates', items:
      Array.from({ length: 6 }, (_, i) => bot(`bot${i}`)) };
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const reading = readTeammateTasks({ ...input, invoke: invoke as RemoteInvoke, sessions: [] });
  const rejected = expect(reading).rejects.toThrow('REVOKED');
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  pending[0].reject(new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'));
  pending[1].resolve({ ok: true, delegations: [] });
  pending[2].resolve({ ok: true, delegations: [] });
  await rejected;
  expect(pending).toHaveLength(3);
});

// Review regression (PR #9752, unit): every Home publish creates a new enrichment fence,
// but companion reads batched by the caller scope reused the superseded snapshot's invoke.
// The newer snapshot's lane reads were rejected and silently dropped from the list.
it('keeps a newer snapshot\'s lanes while a superseded snapshot batch is in flight', async () => {
  const lane = (id: string) => task(id, { source: 'bot', companion: { id: 'cindy-default', role: 'channel' } });
  const history = { ok: true, sessions: [lane('lane')] };
  let releaseOld!: (value: unknown) => void;
  let oldCurrent = true;
  const oldInvoke = vi.fn(async (_device: string, api: string) => {
    if (!oldCurrent) throw new Error('superseded');
    if (api === 'local-db:history:query') return history;
    if (api === 'local-db:sessions:get-many') return new Promise(resolve => { releaseOld = resolve; });
    return { collectionId: 'teammates', items: [] };
  });
  const old = publishHomeTaskSnapshot({ ...input, invoke: oldInvoke as RemoteInvoke, sessions: [task('ordinary')],
    current: () => oldCurrent, publish: () => {}, onReady: () => {} });
  await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
  oldCurrent = false;
  const publish = vi.fn();
  const newer = publishHomeTaskSnapshot({ ...input, sessions: [task('ordinary')], publish, onReady: () => {},
    invoke: (async (_device: string, api: string, args: [string[]]) => {
      if (api === 'local-db:history:query') return history;
      if (api === 'local-db:sessions:get-many') return args[0].map((id: string) => lane(id));
      return { collectionId: 'teammates', items: [] };
    }) as RemoteInvoke });
  await new Promise(resolve => setTimeout(resolve, 0));
  releaseOld([lane('lane')]);
  await Promise.all([old, newer]);
  expect(publish.mock.lastCall?.[0].map((row: RemoteSession) => row.id)).toEqual(['ordinary', 'lane']);
});
