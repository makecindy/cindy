import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll } from 'vitest';
import { expect, it, vi } from 'vitest';
import type { BotRemoteResourceSource } from '../bots.js';

const activity = vi.hoisted(() => ({ snapshot: vi.fn(), snapshots: vi.fn(), copy: vi.fn(async () => ({ text: 'Checking…' })), subscribe: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../../agent-island/service.js', () => ({ getAgentIslandService: () => ({ getSessionActivitySnapshot: activity.snapshot, getSessionActivitySnapshots: activity.snapshots, subscribeSessionActivity: activity.subscribe }) }));
vi.mock('../../../maker-ipc/botRemoteResourceInvalidation.js', () => ({ scheduleBotRemoteResourceChangedForSession: activity.invalidate }));
const readState = vi.hoisted(() => ({ positions: {} as Record<string, number> }));
vi.mock('../../../maker-ipc/botReadStateStore.js', () => ({
  markBotReadPositions: vi.fn((positions: Record<string, number>) => {
    for (const [key, at] of Object.entries(positions)) readState.positions[key] = Math.max(readState.positions[key] ?? 0, at);
  }),
  readBotReadPosition: (key: string) => readState.positions[key] ?? null,
}));

const db = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), current: true, client: null as any }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => db.client }));
vi.mock('../../../maker-ipc/workingStatus.js', () => ({ getWorkingStatusCopy: activity.copy }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => db.current }));
vi.mock('../bots.js', () => ({
  getBotRemoteResourceSource: db.get,
  listBotRemoteResourceSources: db.list,
}));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry.js';
import { createIpcError } from '../../../../shared/ipc-errors.js';
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
  // Previously the roster dropped waiting/error/completion and only sent generation.
  for (const phase of ['needs-interaction', 'error', 'completed']) {
    activity.snapshot.mockReturnValue({ phase });
    expect((await list()).items[0].display.teammateActivity).toEqual({ phase });
    expect((await list()).items[0].display.generation).toBeUndefined();
  }
  activity.snapshot.mockReturnValue({ phase: 'idle' });
  expect((await list()).items[0].display.generation).toBeUndefined();
  const get = () => remoteResourceRegistry.get(context, { client, ref: discovered.ref });

  await expect(get()).resolves.toMatchObject({
    display: { title: 'Sora' },
    links: expect.arrayContaining([{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }]),
  });
  // Teammates keep no todos: new clients get no link; an older computer that still opens the page gets an empty list.
  expect((await get()).links?.some((link) => link.rel === 'todos')).toBe(false);
  await expect(remoteResourceRegistry.get(context, { client, ref: { ...discovered.ref, id: 'todos:bot-1' } }))
    .resolves.toMatchObject({ blocks: [{ primitive: 'teammate-todos', data: { items: [], total: 0 } }] });
  // V2 retired teammate-to-teammate messages; an older computer still sending one gets a stable refusal.
  for (const actionId of ['send-message', 'verify-message', 'message-receipt']) {
    await expect(remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates', actionId, resourceRef: discovered.ref,
      input: { senderBotId: 'sender', targetBotId: 'target', messageId: 'delivery-1', message: 'hello' } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  }
  source.hiddenAt = 200;
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

it('reports a teammate this computer no longer has as not found, without failing the rest of the roster', async () => {
  const present = {
    id: 'bot-1', name: 'Sora', description: '', avatar: '', avatarColor: 'teal', status: 'active' as const,
    canonicalSessionId: 'session-1', hiddenAt: null, pinnedAt: null, currentVersion: 1, updatedAt: 1, activityAt: 1,
  };
  db.list.mockImplementation(async () => [present]);
  db.get.mockImplementation(async (id: string) => {
    if (id === 'gone') throw createIpcError('NOT_FOUND', 'Bot 不存在');
    return { ...present, id };
  });
  const context = { controllerDeviceId: 'remote-mac' };
  const client = { protocolVersion: 1, primitives: ['markdown'] };
  const listed = await remoteResourceRegistry.list(context, { client, collectionId: 'teammates' });
  expect(listed.items.map((item) => item.ref.id)).toEqual(['bot-1']);
  await expect(remoteResourceRegistry.get(context, { client,
    ref: { collectionId: 'teammates', kind: 'bot', id: 'gone' } }))
    .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'remote resource does not exist' });
  await expect(remoteResourceRegistry.get(context, { client,
    ref: { collectionId: 'teammates', kind: 'bot', id: 'todos:gone' } }))
    .rejects.toMatchObject({ code: 'NOT_FOUND', message: "Buddy unavailable" });
});

// The phone and other Macs report what they showed; the host keeps the one position every device reads.
it('advances the host read position from a device, never past the newest message here', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: '', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: null, lastMessageAt: 500, lastMessageRole: 'user', lastReplyAt: 400, needsAttention: false,
    hiddenAt: null, pinnedAt: null, activityAt: 500, currentVersion: 1, updatedAt: 1,
  };
  db.get.mockImplementation(async () => ({ ...source }));
  registerBotRemoteResourceProvider();
  const context = { controllerDeviceId: 'phone' };
  const client = { protocolVersion: 1, primitives: [] };
  const read = (input: Record<string, unknown>, id = 'bot-1') => remoteResourceRegistry.invoke(context, {
    client, collectionId: 'teammates', actionId: 'read', resourceRef: { collectionId: 'teammates', kind: 'bot', id }, input,
  });
  await expect(read({ at: 300 })).resolves.toEqual({ effects: [], lastReadAt: 300 });
  // A skewed clock or a reply that has not arrived here yet cannot pre-read anything.
  await expect(read({ at: 9_999 })).resolves.toEqual({ effects: [], lastReadAt: 500 });
  await expect(read({ at: 100 })).resolves.toEqual({ effects: [], lastReadAt: 500 });
  await expect(read({ at: 'soon' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(read({ at: 300 }, 'bad id')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

// A topic keeps its own position: only the teammate's own live topics can be read, and the
// main chat's position never moves with it.
it('reads a private-chat topic on its own position, only for the teammate\'s own live topics', async () => {
  sqlite.exec(`INSERT INTO bot_session_links VALUES
    ('l-topic', 'bot-1', 'topic-1', 'thread', NULL, 1),
    ('l-archived', 'bot-1', 'topic-gone', 'thread', 5, 1),
    ('l-foreign', 'bot-2', 'topic-2', 'thread', NULL, 1),
    ('l-canonical', 'bot-1', 'session-9', 'canonical', NULL, 1)`);
  db.get.mockImplementation(async () => ({
    id: 'bot-1', name: 'Sora', description: '', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: null, lastMessageAt: 500, lastMessageRole: 'user', lastReplyAt: 400,
    needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 500, currentVersion: 1, updatedAt: 1,
  }));
  registerBotRemoteResourceProvider();
  const mainBefore = readState.positions['bot-1'];
  const read = (input: Record<string, unknown>) => remoteResourceRegistry.invoke({ controllerDeviceId: 'phone' }, {
    client: { protocolVersion: 1, primitives: [] }, collectionId: 'teammates', actionId: 'read',
    resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, input,
  });
  await expect(read({ at: 300, threadSessionId: 'topic-1' })).resolves.toEqual({ effects: [], lastReadAt: 300 });
  const future = await read({ at: Date.now() + 86_400_000, threadSessionId: 'topic-1' }) as unknown as { lastReadAt: number };
  expect(future.lastReadAt).toBeLessThanOrEqual(Date.now());
  for (const threadSessionId of ['topic-gone', 'topic-2', 'session-9', 'missing'])
    await expect(read({ at: 300, threadSessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(read({ at: 300, threadSessionId: 'bad id' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(readState.positions['bot-1']).toBe(mainBefore);
});
