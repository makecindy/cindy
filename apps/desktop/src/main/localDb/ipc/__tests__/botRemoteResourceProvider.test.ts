import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll } from 'vitest';
import { expect, it, vi } from 'vitest';
import type { BotRemoteResourceSource } from '../bots.js';

const activity = vi.hoisted(() => ({ snapshot: vi.fn(), snapshots: vi.fn(), copy: vi.fn(async () => ({ text: 'Checking…' })), subscribe: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../../agent-island/service.js', () => ({ getAgentIslandService: () => ({ getSessionActivitySnapshot: activity.snapshot, getSessionActivitySnapshots: activity.snapshots, subscribeSessionActivity: activity.subscribe }) }));
vi.mock('../../../maker-ipc/botRemoteResourceInvalidation.js', () => ({ scheduleBotRemoteResourceChangedForSession: activity.invalidate }));

const db = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), current: true, client: null as any }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => db.client }));
vi.mock('../../../maker-ipc/workingStatus.js', () => ({ getWorkingStatusCopy: activity.copy }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => db.current }));
vi.mock('../bots.js', () => ({
  getBotRemoteResourceSource: db.get,
  listBotRemoteResourceSources: db.list,
}));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry.js';
import { setBotRemoteMessageService } from '../../../maker-ipc/botRemoteMessageReceiver.js';
import { registerBotRemoteResourceProvider } from '../botRemoteResourceProvider.js';

const sqlite = new Database(':memory:');
sqlite.exec('CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER, created_at INTEGER)');
db.client = { drizzle: drizzle(sqlite) };
afterAll(() => sqlite.close());
activity.snapshots.mockImplementation(() => [{ sessionId: 'session-1', ...activity.snapshot() }]);

it('rejects a previously discovered hidden companion and allows it again after restoration', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer',
    avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: 'Private work',
    lastMessageAt: 100, lastMessageRole: 'assistant', needsAttention: false,
    hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.get.mockImplementation(async () => ({ ...source }));
  db.list.mockImplementation(async () => [{ ...source }]);
  registerBotRemoteResourceProvider();
  const context = { controllerDeviceId: 'remote-mac' };
  const client = { protocolVersion: 1, primitives: ['markdown'] };
  const list = () => remoteResourceRegistry.list(context, { client, collectionId: 'teammates' });
  const discovered = (await list()).items[0];
  // Generation comes from host activity even when no controller has opened chat.
  activity.snapshot.mockReturnValue({ phase: 'running', workingPhase: 'reading-memory', startedAtMs: 123 });
  const running = (await list()).items[0];
  expect(running.display.generation).toEqual({ phase: 'reading-memory', startedAt: 123 });
  expect(running.revision).not.toEqual(discovered.revision);
  const notify = activity.subscribe.mock.calls[0][0];
  const previous = { phase: 'running', workingPhase: 'reading-memory', startedAtMs: 123 };
  notify({ sessionId: 'session-1', previous, current: { ...previous, compactDetail: 'More private text' } });
  expect(activity.invalidate).not.toHaveBeenCalled();
  notify({ sessionId: 'session-1', previous, current: { phase: 'idle' } });
  expect(activity.invalidate).toHaveBeenCalledWith('session-1');
  for (const workingPhase of ['compacting', 'thinking', 'replying']) {
    const current = { ...previous, workingPhase };
    activity.snapshot.mockReturnValue(current);
    notify({ sessionId: 'session-1', previous, current });
    expect((await list()).items[0].display.generation).toEqual({ phase: workingPhase, startedAt: 123 });
    expect(activity.invalidate).toHaveBeenCalledWith('session-1');
  }
  activity.snapshot.mockReturnValue({ phase: 'idle' });
  expect((await list()).items[0].display.generation).toBeUndefined();
  const get = () => remoteResourceRegistry.get(context, { client, ref: discovered.ref });

  await expect(get()).resolves.toMatchObject({
    display: { title: 'Sora' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
  });
  const receiveRemote = vi.fn(async () => ({ ok: false as const, errorCode: 'TEST_RECEIPT', message: 'test' }));
  const verifyRemoteMessage = vi.fn(async () => true);
  const readRemoteReceipt = vi.fn(async () => ({ messageId: 'delivery-1', accepted: true as const }));
  setBotRemoteMessageService({ receiveRemote, verifyRemoteMessage, readRemoteReceipt });
  await expect(remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'message-receipt', resourceRef: discovered.ref,
    input: { senderBotId: 'sender', messageId: 'delivery-1', controllerDeviceId: 'spoofed' } }))
    .resolves.toMatchObject({ effects: [], messageId: 'delivery-1', accepted: true });
  expect(readRemoteReceipt).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'sender', targetBotId: 'bot-1', messageId: 'delivery-1' });
  const invoke = () => remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'send-message', resourceRef: discovered.ref,
    input: { senderBotId: 'sender', messageId: 'delivery-1', message: 'hello', controllerDeviceId: 'spoofed' } });
  await expect(invoke()).resolves.toMatchObject({ effects: [], teammateMessage: { errorCode: 'TEST_RECEIPT' } });
  expect(receiveRemote).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'sender',
    targetBotId: 'bot-1', messageId: 'delivery-1', message: 'hello' });
  await expect(remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'verify-message', resourceRef: discovered.ref,
    input: { targetBotId: 'target', messageId: 'delivery-1', message: 'hello', controllerDeviceId: 'spoofed' } }))
    .resolves.toMatchObject({ effects: [], verified: true });
  expect(verifyRemoteMessage).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'bot-1',
    targetBotId: 'target', messageId: 'delivery-1', message: 'hello' });
  const longBotId = 'b'.repeat(128);
  for (const actionId of ['send-message', 'verify-message', 'message-receipt']) {
    const request = { client, collectionId: 'teammates', actionId,
      resourceRef: { ...discovered.ref, id: longBotId },
      input: { senderBotId: longBotId, targetBotId: longBotId, messageId: 'delivery-1', message: 'hello' } };
    await expect(remoteResourceRegistry.invoke(context, request)).resolves.toMatchObject({ effects: [] });
    await expect(remoteResourceRegistry.invoke(context, { ...request, resourceRef: { ...request.resourceRef, id: longBotId + 'b' } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remoteResourceRegistry.invoke(context, { ...request,
      input: { ...request.input, senderBotId: longBotId + 'b', targetBotId: longBotId + 'b' } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remoteResourceRegistry.invoke(context, { ...request, input: { ...request.input, messageId: 'm'.repeat(81) } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
  expect(receiveRemote).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  expect(verifyRemoteMessage).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  expect(readRemoteReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  db.current = false;
  await expect(invoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  db.current = true;
  source.hiddenAt = 200;
  await expect(invoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(receiveRemote).toHaveBeenCalledTimes(2);
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({
    code: 'NOT_FOUND', message: 'remote resource does not exist',
  });
  expect(db.get).toHaveBeenLastCalledWith('bot-1');

  source.hiddenAt = null;
  source.status = 'archived';
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  source.status = 'active';
  expect((await list()).items).toHaveLength(1);
  await expect(get()).resolves.toMatchObject({ display: { title: 'Sora' } });
});


it('projects and polishes a running delegation, with canonical priority and terminal cleanup', async () => {
  registerBotRemoteResourceProvider();
  sqlite.exec("INSERT INTO bot_session_links VALUES ('d', 'bot-1', 'delegated', 'delegation', NULL, 2), ('a', 'bot-1', 'archived', 'delegation', 3, 3), ('other', 'bot-2', 'foreign', 'delegation', NULL, 4)");
  const source = { id: 'bot-1', name: 'Sora', description: '', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', hiddenAt: null, pinnedAt: null, currentVersion: 1, updatedAt: 1, activityAt: 1 };
  db.get.mockResolvedValue(source); db.list.mockResolvedValue([source]);
  const running = (sessionId: string) => ({ sessionId, phase: 'running', workingPhase: 'testing', startedAtMs: 123 });
  activity.snapshots.mockReturnValue([running('delegated'), running('archived'), running('foreign')]);
  const context = { controllerDeviceId: 'remote-mac' };
  const client = { protocolVersion: 1, primitives: ['markdown'], locale: 'en' };
  const list = () => remoteResourceRegistry.list(context, { client, collectionId: 'teammates' });
  expect((await list()).items[0].display.generation).toEqual({ phase: 'testing', startedAt: 123 });
  const getCopy = () => remoteResourceRegistry.get(context, { client,
    ref: { collectionId: 'teammates', kind: 'bot', id: 'working:bot-1/testing' } });
  await getCopy();
  expect(activity.copy).toHaveBeenLastCalledWith({ sessionId: 'delegated', phase: 'testing', locale: 'en' });
  activity.snapshots.mockReturnValue([running('delegated'), { ...running('session-1'), workingPhase: 'compacting', startedAtMs: 124 }]);
  expect((await list()).items[0].display.generation).toEqual({ phase: 'compacting', startedAt: 124 });
  await getCopy();
  expect(activity.copy).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
  // No archival or other-Bot link can keep this companion busy after its task stops.
  activity.snapshots.mockReturnValue([running('archived'), running('foreign')]);
  expect((await list()).items[0].display.generation).toBeUndefined();
  await expect(getCopy()).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
