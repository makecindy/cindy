import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { createChatServerClient, type ChatActor, type ChatMessage } from '@/chat/chatServerClient';
import {
  CLOUD_SWITCH_TIMEOUT_MS, cloudActorForRow, cloudCompanionMessages, cloudSwitchAfterSetHome, cloudSwitchCandidates,
  cloudSwitchTick, cloudCompanionRows, cloudHomeTargets, type CloudSwitchState,
} from '@/chat/cloudCompanion';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (botId: string, deviceId: string, kind = 'bot'): HostedRemoteCollectionItem => ({
  key: `${deviceId}:${botId}`, host: { deviceId, deviceName: `Mac ${deviceId}` },
  item: { ref: { collectionId: 'teammates', kind, id: botId }, revision: '1', display: { title: botId }, links: [] },
}) as HostedRemoteCollectionItem;
const actor = (n: number, externalId: string, homeDeviceId: string | null, kind = 'bot'): ChatActor =>
  ({ id: id(n), kind, externalId, name: externalId, avatar: null, homeDeviceId });

describe('cloud companion rows', () => {
  it('matches a row only to the actor whose main computer is that row\'s computer', () => {
    const actors = [actor(1, 'cindy', 'mac-a'), actor(2, 'lizi', null), actor(3, 'human-x', 'mac-a', 'human')];
    expect(cloudActorForRow(actors, row('cindy', 'mac-a'))?.id).toBe(id(1));
    expect(cloudActorForRow(actors, row('cindy', 'mac-b'))).toBeNull();
    expect(cloudActorForRow(actors, row('lizi', 'mac-a'))).toBeNull();
    expect(cloudActorForRow(actors, row('human-x', 'mac-a'))).toBeNull();
    expect(cloudActorForRow(actors, row('cindy', 'mac-a', 'bot-group'))).toBeNull();
  });

  it('lists each companion once, under its main computer, adding a row for an unlisted main computer', () => {
    const items = [row('cindy', 'mac-a'), row('cindy', 'mac-b'), row('dash', 'mac-b'), row('lizi', 'mac-a'), row('ada', 'mac-a')];
    const actors = [actor(1, 'cindy', 'mac-b'), actor(2, 'dash', 'mac-a'), actor(3, 'lizi', 'mac-c'), actor(4, 'ada', null),
      { ...actor(5, 'mia', 'mac-c'), avatar: '🦊' }];
    const rows = cloudCompanionRows(items, actors, new Map([['mac-a', 'Studio']]));
    // cindy: only mac-b; dash and lizi: old copies replaced by their main computer's row; ada: no main computer, as listed.
    expect(rows.map(item => `${item.host.deviceId}:${item.item.ref.id}`))
      .toEqual(['mac-b:cindy', 'mac-a:ada', 'mac-a:dash', 'mac-c:lizi', 'mac-c:mia']);
    expect(rows.find(item => item.item.ref.id === 'dash')?.host.deviceName).toBe('Studio');
    // A new phone that never saw the main computer still gets an entry for the cloud conversation.
    const mia = rows.find(item => item.item.ref.id === 'mia')!;
    expect(mia.host).toEqual({ deviceId: 'mac-c', deviceName: 'mac-c' });
    expect(mia.item.display).toMatchObject({ title: 'mia', avatar: { kind: 'emoji', value: '🦊' } });
    expect(cloudActorForRow(actors, mia)?.id).toBe(id(5));
    expect(cloudCompanionRows(items, []).map(item => item.key)).toEqual(items.map(item => item.key));
  });

  it('offers online controllable computers except the current main computer and phones', () => {
    const device = (deviceId: string, canOpen: boolean, platform: string | null = 'darwin') =>
      ({ canOpen, device: { deviceId, name: `Name ${deviceId}`, platform } });
    expect(cloudSwitchCandidates([device('home', true), device('b', true), device('c', false), device('phone', true, 'ios'), device('w', true, 'win32')], 'home'))
      .toEqual([{ deviceId: 'b', name: 'Name b' }, { deviceId: 'w', name: 'Name w' }]);
  });

  it('projects the 1:1 room oldest first with the companion and owner sides', () => {
    const message = (n: number, authorId: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
      id: id(n), seq: String(n), authorId, author: { kind: authorId === id(1) ? 'bot' : 'human', name: '' }, createdAt: '2026-10-13T00:00:00Z',
      deleted: false, threadRootId: null, content: [{ type: 'text', text }], ...extra });
    const view = cloudCompanionMessages([
      message(12, id(1), 'reply'), message(11, id(9), 'hello'), message(11, id(9), 'hello'),
      message(13, id(9), 'gone', { deleted: true }), message(14, id(9), 'notice', { origin: 'system' }), message(15, id(1), '  '),
    ], id(1));
    expect(view.map(item => [item.text, item.fromCompanion])).toEqual([['hello', false], ['reply', true]]);
  });
  it('orders by message time, so older history uploaded later still appears first', () => {
    const at = (n: number, time: string): ChatMessage => ({ id: id(n), seq: String(n), authorId: id(9), author: { kind: 'human', name: '' },
      createdAt: time, deleted: false, threadRootId: null, content: [{ type: 'text', text: `m${n}` }] });
    const view = cloudCompanionMessages([at(20, '2026-10-14T00:00:00Z'), at(30, '2026-09-01T00:00:00Z')], id(1));
    expect(view.map(item => item.text)).toEqual(['m30', 'm20']);
  });

  it('offers the computers the main computer names, never itself or this phone', () => {
    const targets = [{ deviceId: 'home', online: true }, { deviceId: 'phone', online: true }, { deviceId: 'mac', online: true }, { deviceId: 'off', online: false }];
    expect(cloudHomeTargets(targets, 'home', 'phone').map(target => target.deviceId)).toEqual(['mac']);
  });
});

describe('switching the main computer', () => {
  const target = { deviceId: 'mac-b', name: 'Studio' };

  it('waits after a successful compare-and-set and reports a conflict with the winning computer', () => {
    expect(cloudSwitchAfterSetHome(target, { ok: true, homeDeviceId: 'mac-b' }, 5)).toEqual({ phase: 'waiting', target, since: 5 });
    expect(cloudSwitchAfterSetHome(target, { ok: false, homeDeviceId: 'mac-c' }, 5)).toEqual({ phase: 'conflict', homeDeviceId: 'mac-c' });
    // Someone else already moved it to the same computer: just wait for it.
    expect(cloudSwitchAfterSetHome(target, { ok: false, homeDeviceId: 'mac-b' }, 5).phase).toBe('waiting');
  });

  it('opens the companion once the new computer lists it in a fresh read, and times out otherwise', () => {
    const waiting: CloudSwitchState = { phase: 'waiting', target, since: 1000 };
    const others = [row('cindy', 'mac-a'), row('dash', 'mac-b')];
    const fresh = () => true;
    expect(cloudSwitchTick(waiting, others, 'cindy', 1000 + CLOUD_SWITCH_TIMEOUT_MS - 1, fresh)).toEqual({ state: waiting, arrived: null });
    expect(cloudSwitchTick(waiting, others, 'cindy', 1000 + CLOUD_SWITCH_TIMEOUT_MS, fresh)).toEqual({ state: { phase: 'timeout', target }, arrived: null });
    const arrived = row('cindy', 'mac-b');
    // A cached row from an earlier stay on that computer does not end the wait.
    expect(cloudSwitchTick(waiting, [...others, arrived], 'cindy', 2000, () => false)).toEqual({ state: waiting, arrived: null });
    expect(cloudSwitchTick(waiting, [...others, arrived], 'cindy', 2000, fresh)).toEqual({ state: { phase: 'idle' }, arrived });
    const idle: CloudSwitchState = { phase: 'idle' };
    expect(cloudSwitchTick(idle, [arrived], 'cindy', 2000, fresh)).toEqual({ state: idle, arrived: null });
  });
});

describe('Chat Server client for companions', () => {
  it('reads the capability only from a human /me and keeps valid actors', async () => {
    const request = vi.fn(async (path: string): Promise<unknown> => path === '/me'
      ? { actor: { id: id(9), kind: 'human' }, deviceId: 'phone', capabilities: { companionHome: true } }
      : [{ id: id(1), kind: 'bot', externalId: 'cindy', name: 'Cindy', avatar: null, homeDeviceId: 'mac-a' },
        { id: 'not-an-id', kind: 'bot', externalId: 'x', name: 'X', avatar: null, homeDeviceId: null },
        // Deleted on its main computer: retired, never offered again.
        { id: id(2), kind: 'bot', externalId: 'old', name: 'Old', avatar: null, homeDeviceId: 'mac-a', disabled: true }]);
    const client = createChatServerClient(request as never);
    await expect(client.capabilities()).resolves.toEqual({ companionHome: true });
    await expect(client.actors()).resolves.toEqual([{ id: id(1), kind: 'bot', externalId: 'cindy', name: 'Cindy', avatar: null, homeDeviceId: 'mac-a' }]);
    request.mockResolvedValueOnce({ actor: { id: id(9), kind: 'human' } });
    await expect(client.capabilities()).resolves.toEqual({ companionHome: false });
  });

  it('reads the profile snapshot as the companion, and only a complete one counts', async () => {
    const request = vi.fn(async (): Promise<unknown> => [{ key: 'companion.profile.v1',
      value: { name: 'Cindy', description: '', soul: '', systemPrompt: '', user: '' } }]);
    const client = createChatServerClient(request as never);
    await expect(client.hasProfileSnapshot(id(1))).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith('/preferences', 'GET', undefined, id(1));
    request.mockResolvedValueOnce([{ key: 'companion.memory.v1:a.md', value: { content: 'x' } }]);
    await expect(client.hasProfileSnapshot(id(1))).resolves.toBe(false);
    request.mockResolvedValueOnce([{ key: 'companion.profile.v1', value: null }]);
    await expect(client.hasProfileSnapshot(id(1))).resolves.toBe(false);
    request.mockResolvedValueOnce([{ key: 'companion.profile.v1', value: { name: 'Cindy' } }]);
    await expect(client.hasProfileSnapshot(id(1))).resolves.toBe(false);
  });

  it('sends compare-and-set and returns a typed conflict', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: id(1), homeDeviceId: 'mac-b' })
      .mockRejectedValueOnce(new ApiError('HOME_DEVICE_CONFLICT', 409, 'conflict', { homeDeviceId: 'mac-c' }))
      .mockRejectedValueOnce(new ApiError('HOME_DEVICE_CONFLICT', 409, 'conflict'))
      .mockRejectedValueOnce(new ApiError('FORBIDDEN', 403, 'no'));
    const client = createChatServerClient(request);
    await expect(client.setHome(id(1), 'mac-b', 'mac-a')).resolves.toEqual({ ok: true, homeDeviceId: 'mac-b' });
    expect(request).toHaveBeenCalledWith(`/actors/${id(1)}`, 'PATCH', { homeDeviceId: 'mac-b', expectedHomeDeviceId: 'mac-a' });
    await expect(client.setHome(id(1), 'mac-b', 'mac-a')).resolves.toEqual({ ok: false, homeDeviceId: 'mac-c' });
    await expect(client.setHome(id(1), 'mac-b', 'mac-a')).resolves.toEqual({ ok: false, homeDeviceId: null });
    await expect(client.setHome(id(1), 'mac-b', 'mac-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('resolves the companion room, falling back to the desktop\'s name-keyed operation', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiError('OPERATION_CONFLICT', 409, 'conflict'))
      .mockResolvedValueOnce({ id: id(5) });
    const hash = vi.fn(async () => 'abcdef0123456789');
    const client = createChatServerClient(request);
    await expect(client.companionRoom(id(1), ' Cindy ', hash)).resolves.toBe(id(5));
    const body = { kind: 'direct', name: 'Cindy', participants: [id(1)], sourceId: id(1) };
    expect(request.mock.calls).toEqual([
      ['/conversations', 'POST', { operationId: `companion-room:${id(1)}`, ...body }],
      ['/conversations', 'POST', { operationId: `companion-room:${id(1)}:abcdef012345`, ...body }],
    ]);
    expect(hash).toHaveBeenCalledWith('Cindy');
  });

  it('pages the direct room history without the group filter', async () => {
    const page = Array.from({ length: 100 }, (_, n) => ({ id: id(300 - n), seq: String(300 - n) }));
    const request = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce([{ id: id(1), seq: '1' }]);
    const client = createChatServerClient(request);
    const first = await client.history(id(5));
    expect(first.before).toBe('201');
    expect(request).toHaveBeenLastCalledWith(`/conversations/${id(5)}/messages?limit=100`);
    await expect(client.history(id(5), first.before)).resolves.toMatchObject({ before: null });
    expect(request).toHaveBeenLastCalledWith(`/conversations/${id(5)}/messages?limit=100&before=201`);
  });
});
