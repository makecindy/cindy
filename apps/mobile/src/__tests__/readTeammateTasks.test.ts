import { describe, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_LIST_CHANNEL } from '@cindy/device-link';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { readTeammateTasks } from '@/session/readTeammateTasks';
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
