/**
 * Opening a server group waits on main's Chat Server reads. Every request here answers after
 * a fixed simulated round trip, so the elapsed fake time counts the serial request rounds on
 * the open path. These are simulated latencies, not production measurements.
 *
 * The realtime cases run against a small model of the Chat Server contract (chat-server
 * sync.ts / realtime.ts): a snapshot returns its scope head as `cursor`, a subscription
 * delivers every change after its cursor, and the next batch waits for the ack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ handle: vi.fn(), latencyMs: 100, profiles: [] as unknown[], localGroupIds: [] as string[],
  sockets: [] as Array<import('ws').WebSocket>, routes: [] as string[], download: vi.fn(), cacheGeneration: 0, page: [] as unknown[],
  /** When the server reads its state and when the answer reaches the client, in ms after the request. */
  timing: null as null | ((route: string) => { serve: number; deliver: number }),
  offline: false, onFrame: null as null | ((socket: unknown, frame: Record<string, unknown>) => void) }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: fixture.download,
  get cacheGeneration() { return fixture.cacheGeneration; } }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatSendJournal.js', () => ({ chatSendJournal: () => ({ read: () => null, save: vi.fn(), confirm: vi.fn(), forgetRoom: vi.fn() }) }));
vi.mock('../chatLocalHistory.js', () => ({ chatLocalHistory: () => ({ read: () => null, save: vi.fn(), forget: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: () => '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), {
    limit: async () => fixture.localGroupIds.map(id => ({ id })),
  }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
}, tx: async () => undefined }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string }, callback: (response: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        const route = new URL(url).pathname.slice(3) + new URL(url).search;
        fixture.routes.push(route);
        const { serve, deliver } = fixture.timing?.(route) ?? { serve: fixture.latencyMs, deliver: fixture.latencyMs };
        setTimeout(() => {
          if (fixture.offline) { setTimeout(() => req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), deliver - serve); return; }
          const answered = Promise.resolve(fixture.handle(route, options.method, data ? JSON.parse(data) : undefined));
          const answer = () => void answered.then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200, headers: {} });
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
          if (deliver > serve) setTimeout(answer, deliver - serve); else answer();
        }, serve);
      },
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  } };
});
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 1;
    send = vi.fn((frame: string) => fixture.onFrame?.(this, JSON.parse(frame)));
    constructor() { super(); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';
import type { ChatHistoryState, ChatHistoryStore } from '@cindy/maker-shared/chat-history';

const selfId = '30000000-0000-4000-8000-000000000001';
const rooms = Array.from({ length: 8 }, (_, index) => `10000000-0000-4000-8000-00000000000${index + 1}`);
const room = (id: string) => ({ id, kind: 'group', name: `Room ${id.slice(-1)}`, state: 'joined', response_mode: 'all', speaking_mode: 'auto',
  created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z', revision: 1, archived: false });
const message = { id: '50000000-0000-4000-8000-000000000001', seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' },
  content: [{ type: 'text', text: 'hello' }], createdAt: '2026-10-03T00:00:00Z', deleted: false, threadRootId: null };
function response(route: string) {
  if (route === '/me') return { body: { actor: { id: selfId } } };
  if (route === '/actors') return { body: [] };
  if (route.startsWith('/conversations?')) return { body: rooms.map(room) };
  if (route.endsWith('/snapshot')) return { body: { room: room(route.split('/')[2]), members: [], messages: [], cursor: '57' } };
  if (route === '/executions/claim') return { body: { execution: null } };
  if (route.includes('/messages?')) return { body: fixture.page };
  if (route.endsWith('/executions') || route.includes('/execution-failures?') || route.includes('/plans')) return { body: [] };
  return { body: {} };
}

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T; routes: string[] }> {
  const start = Date.now();
  const from = fixture.routes.length;
  let settled: { value: T } | undefined;
  void run().then(value => { settled = { value }; });
  while (!settled) await vi.advanceTimersByTimeAsync(5);
  // Background claims/leases are independent of the open path.
  const routes = fixture.routes.slice(from).filter(route => !route.startsWith('/executions/'));
  return { ms: Date.now() - start, value: settled.value, routes };
}

describe('Chat Server group open latency (simulated 100ms per request)', () => {
  let service: BotGroupChatService;
  let local: { listGroups: ReturnType<typeof vi.fn>; settleLaneTurn: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let onChanged: ReturnType<typeof vi.fn>;
  // Each scenario starts right after an actor registration, as the two-second poll keeps it.
  const warm = async () => { await timed(() => service.chatServer!.ownedBots()); };
  const sent = () => vi.mocked(fixture.sockets[0].send).mock.calls.map(([frame]) => JSON.parse(String(frame)));
  async function connected() {
    await vi.advanceTimersByTimeAsync(2500);
    fixture.sockets[0].emit('message', JSON.stringify({ type: 'ready' }));
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.routes = []; fixture.sockets = []; fixture.profiles = []; fixture.localGroupIds = []; fixture.latencyMs = 100;
    fixture.timing = null; fixture.offline = false; fixture.onFrame = null; fixture.cacheGeneration = 0;
    fixture.page = [message];
    fixture.handle.mockImplementation(response);
    fixture.download.mockResolvedValue(null);
    onChanged = vi.fn();
    local = { listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() };
    service = withChatServer(local as unknown as BotGroupChatService, { onChanged } as unknown as BotGroupChatServiceDeps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  // Unit: the production topic entry used to bypass persisted history on every open.
  // Restart, old-page edits and a permission reset must all share the room projection.
  it('reopens topics without downloading members, roots or covered pages and updates old replies', async () => {
    const disk = new Map<string, ChatHistoryState>();
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    const open = () => withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    const old = { ...message, id: '50000000-0000-4000-8000-000000000002', seq: '2', revision: 1, threadRootId: message.id };
    const latest = { ...old, id: '50000000-0000-4000-8000-000000000003', seq: '3' };
    let revoked = false;
    fixture.handle.mockImplementation(route => route.startsWith('/changes?')
      ? revoked ? { status: 403, body: { error: { code: 'NOT_MEMBER' } } }
        : { body: { cursor: '58', changes: [{ type: 'message.updated', data: { message: { ...old, revision: 2,
          content: [{ type: 'text', text: 'old reply edited' }] } } }], hasMore: false } }
      : route.endsWith(`/messages/${message.id}`) ? { body: message }
      : route.endsWith('/members') ? { body: [] }
      : revoked && route.includes('/execution-failures?') ? { status: 403, body: { error: { code: 'NOT_MEMBER' } } }
      : route.includes('/messages?') ? { body: route.includes('before=3') ? [old] : [latest] } : response(route));
    service.dispose(); service = open();
    const input = { groupId: rooms[0], rootId: message.id };
    const initial = await timed(() => service.chatServer!.thread(input));
    expect(initial.value).toMatchObject({ ok: true, root: { id: message.id }, replies: [{ id: latest.id }] });
    await timed(() => service.chatServer!.thread({ ...input, before: 3 }));
    const warm = await timed(() => service.chatServer!.thread(input));
    expect(warm.routes.filter(route => /\/(snapshot|members|messages)(\?|\/|$)/.test(route))).toEqual([]);
    expect(warm.routes).toHaveLength(1); // Only execution failures; no changed read position in this scenario.
    service.dispose(); service = open();
    const restored = await timed(() => service.chatServer!.thread({ ...input, sourceMessageIds: [old.id] }));
    expect(restored.value).toMatchObject({ ok: true, historyRevision: expect.any(String),
      messageUpdates: [{ id: old.id, content: 'old reply edited' }] });
    expect(restored.routes.filter(route => /\/(snapshot|members|messages)(\?|\/|$)/.test(route))).toEqual([]);
    revoked = true;
    expect((await timed(() => service.chatServer!.thread(input))).value).toMatchObject({ ok: false, errorCode: 'NOT_MEMBER' });
    expect(disk.size).toBe(0);
  });

  // Unit, PR #7396: a missing root and a lost membership both use HTTP 404.
  // Only the latter may discard another topic's durable history and page coverage.
  it.each(['MESSAGE_NOT_FOUND', 'CONVERSATION_NOT_FOUND'])('scopes a topic HTTP 404 to its server error code (%s)', async code => {
    const disk = new Map<string, ChatHistoryState>();
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    const missingRoot = '50000000-0000-4000-8000-000000000099';
    const reply = { ...message, id: '50000000-0000-4000-8000-000000000002', seq: '2', threadRootId: message.id };
    fixture.handle.mockImplementation(route => route.startsWith('/changes?')
      ? { body: { cursor: '57', changes: [], hasMore: false } }
      : route.endsWith(`/messages/${missingRoot}`) ? { status: 404, body: { error: { code } } }
      : route.endsWith(`/messages/${message.id}`) ? { body: message }
      : route.includes('/messages?') ? { body: route.includes(missingRoot) ? [] : [reply] } : response(route));
    service.dispose(); service = withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    const input = { groupId: rooms[0], rootId: message.id };
    const initial = await timed(() => service.chatServer!.thread(input));
    expect(initial.value).toMatchObject({ ok: true, replies: [{ id: reply.id }] });
    expect((await timed(() => service.chatServer!.thread({ ...input, rootId: missingRoot }))).value)
      .toMatchObject({ ok: false, errorCode: code });
    if (code === 'CONVERSATION_NOT_FOUND') {
      expect(disk.size).toBe(0);
    } else {
      expect(disk.size).toBe(1);
      const resumed = await timed(() => service.chatServer!.thread(input));
      expect(resumed.value).toMatchObject({ ok: true, replies: [{ id: reply.id }],
        historyRevision: initial.value.ok && initial.value.historyRevision });
      // The failed topic's parallel page may still finish; the surviving topic
      // must not download its root/page or re-bootstrap the room.
      expect(resumed.routes.filter(route => !route.includes(missingRoot) && /\/(snapshot|members|messages)(\?|\/|$)/.test(route))).toEqual([]);
    }
  });

  // Unit: the topic composes independently awaited root, page and failure reads;
  // a membership reset between them must retry, just like the group entry point.
  it('retries a topic if membership resets while execution failures are loading', async () => {
    const disk = new Map<string, ChatHistoryState>();
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    fixture.page = [{ ...message, id: '50000000-0000-4000-8000-000000000002', seq: '2', threadRootId: message.id }];
    fixture.handle.mockImplementation(route => route.startsWith('/changes?')
      ? { body: { cursor: '57', changes: [], hasMore: false } }
      : route.endsWith(`/messages/${message.id}`) ? { body: message } : response(route));
    service.dispose(); service = withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    const input = { groupId: rooms[0], rootId: message.id };
    const before = await timed(() => service.chatServer!.thread(input)); await connected();
    fixture.timing = route => ({ serve: 100, deliver: route.includes('/execution-failures?') ? 500 : 100 });
    const pending = service.chatServer!.thread(input);
    await vi.advanceTimersByTimeAsync(120);
    fixture.page = [];
    fixture.sockets[0].emit('message', JSON.stringify({ type: 'changes', scope: `conversation:${rooms[0]}`, cursor: '58',
      changes: [{ type: 'membership.changed' }] }));
    const after = await timed(() => pending);
    expect(after.value).toMatchObject({ ok: true, replies: [] });
    expect(after.value.ok && after.value.historyRevision).not.toBe(before.value.ok && before.value.historyRevision);
  });

  // Unit: a membership reset while execution metadata is loading must not relabel old messages as the new history.
  it('retries a composed group view if its cached history resets during another HTTP read', async () => {
    const disk = new Map<string, ChatHistoryState>();
    fixture.handle.mockImplementation(route => route.startsWith('/changes?')
      ? { body: { cursor: '57', changes: [], hasMore: false } } : response(route));
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    service.dispose(); service = withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    await timed(() => service.getGroup(rooms[0])); await connected();
    fixture.timing = route => ({ serve: 100, deliver: route.endsWith('/executions') ? 500 : 100 });
    const pending = service.getGroup(rooms[0]);
    // Latest message page has been read from disk; the response is waiting for execution state.
    await vi.advanceTimersByTimeAsync(120);
    fixture.page = [];
    fixture.sockets[0].emit('message', JSON.stringify({ type: 'changes', scope: `conversation:${rooms[0]}`, cursor: '58',
      changes: [{ type: 'membership.changed' }] }));
    const result = await timed(() => pending);
    expect(result.value).toMatchObject({ ok: true, group: { messages: [] } });
  });

  // Unit: production adapter + persisted projection; old open-path tests only covered HTTP invalidation.
  it('persists historical edits before ACK and reopens from disk with only an incremental read', async () => {
    const disk = new Map<string, ChatHistoryState>();
    let block: Promise<void> | undefined;
    let finish!: () => void;
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      await block; if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    const open = () => withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    service.dispose(); service = open();
    const old = { ...message, id: '50000000-0000-4000-8000-000000000002', seq: '2', revision: 1 };
    fixture.page = Array.from({ length: 100 }, (_, index) => ({ ...message, seq: String(200 - index),
      id: `50000000-0000-4000-8000-${String(200 - index).padStart(12, '0')}` }));
    let head = '57';
    fixture.handle.mockImplementation(route => route.startsWith('/changes?') ? { body: { cursor: head, changes: [], hasMore: false } }
      : route.includes('/messages?') && route.includes('before=5') ? { body: [old] } : response(route));
    await timed(() => service.getGroup(rooms[0]));
    await timed(() => service.getGroup(rooms[0], { beforeSequence: 5 }));
    await connected();
    await timed(() => service.getGroup(rooms[0]));
    block = new Promise(resolve => { finish = resolve; });
    const ws = fixture.sockets[0]; vi.mocked(ws.send).mockClear();
    ws.emit('message', JSON.stringify({ type: 'changes', scope: `conversation:${rooms[0]}`, cursor: '58', changes: [
      { type: 'message.updated', entityId: old.id, data: { message: { ...old, revision: 2, content: [{ type: 'text', text: 'edited remotely' }] } } },
    ] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent().some(frame => frame.type === 'ack')).toBe(false);
    expect(disk.get(rooms[0])?.cursor).toBe('57');
    head = '58'; finish(); block = undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toContainEqual({ type: 'ack', scope: `conversation:${rooms[0]}`, cursor: '58' });
    const refreshed = await timed(() => service.getGroup(rooms[0], { sourceMessageIds: [old.id] }));
    expect(refreshed.value.ok && refreshed.value.group.messageUpdates?.[0]?.content).toBe('edited remotely');
    service.dispose(); service = open();
    const restart = await timed(() => service.getGroup(rooms[0], { beforeSequence: 5 }));
    expect(restart.value.ok && restart.value.group.messages[0]?.content).toBe('edited remotely');
    expect(restart.routes.filter(route => route.includes('/snapshot') || route.includes('/messages?'))).toEqual([]);
    expect(restart.routes.some(route => route.startsWith('/changes?') && route.includes('after=58'))).toBe(true);
  });

  // Unit: an old-page update must retain the authoritative thread-share projection,
  // including a deleted source, instead of replacing it with its untrusted fallback.
  it('decorates cached old-page message updates with thread references', async () => {
    const disk = new Map<string, ChatHistoryState>();
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    service.dispose(); service = withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    const root = { ...message, id: '50000000-0000-4000-8000-000000000003', replyCount: 1 };
    const reply = { ...message, id: '50000000-0000-4000-8000-000000000004', seq: '2', threadRootId: root.id, deleted: true, content: [] };
    const share = { ...message, id: '50000000-0000-4000-8000-000000000005', seq: '3', content: [{ type: 'card',
      namespace: 'cindy.thread-share', schemaRevision: 1, fallback: 'deleted private text', data: { messageId: reply.id, threadRootId: root.id } }] };
    fixture.handle.mockImplementation(route => route.startsWith('/changes?') ? { body: { cursor: '57', changes: [], hasMore: false } }
      : route.endsWith('/snapshot') ? { body: { room: room(rooms[0]), members: [], messages: [{ ...reply, id: '50000000-0000-4000-8000-000000000006', deleted: false, content: message.content }, reply, root], cursor: '57' } }
      : route.includes('/messages?') && route.includes('before=5') ? { body: [share, root] } : response(route));
    await timed(() => service.getGroup(rooms[0], { beforeSequence: 5 }));
    const result = await timed(() => service.getGroup(rooms[0], { sourceMessageIds: [share.id, root.id],
      shownShares: [{ id: share.id, messageId: reply.id, threadRootId: root.id }] }));
    expect(result.value.ok && result.value.group.messageUpdates?.find(view => view.id === share.id)?.threadShare)
      .toMatchObject({ messageId: reply.id, status: 'unavailable', content: '' });
    expect(result.value.ok && result.value.group.messageUpdates?.find(view => view.id === root.id)?.threadPreview?.replies[0]?.text).toBe('hello');
  });

  // Unit: all successful local /read writers must update the durable UI projection
  // even while WS is unavailable; existing HTTP tests had no persistent cache.
  it.each(['main', 'thread', 'follow'] as const)('invalidates personal metadata after a local %s write without a socket notice', async action => {
    const disk = new Map<string, ChatHistoryState>();
    const store: ChatHistoryStore = { read: async room => structuredClone(disk.get(room)), write: async (room, state) => {
      if (state) disk.set(room, structuredClone(state)); else disk.delete(room);
    } };
    service.dispose(); service = withChatServer(local as unknown as BotGroupChatService,
      { onChanged, chatHistoryStore: () => store } as unknown as BotGroupChatServiceDeps);
    const root = { ...message, authorId: '30000000-0000-4000-8000-000000000002', replyCount: 1 };
    const reply = { ...root, id: '50000000-0000-4000-8000-000000000002', seq: '2', threadRootId: root.id };
    let mainRead = '0', threadRead = '0', following = false;
    fixture.page = [root];
    fixture.handle.mockImplementation((route, method, body) => {
      if (route.endsWith('/read') && method === 'POST') {
        if (body.threadRootId) { threadRead = body.readSeq; following = body.following ?? following; }
        else mainRead = body.readSeq;
        return { body: { following } };
      }
      if (route.endsWith('/snapshot')) return { body: { room: room(rooms[0]), members: [], messages: [reply, root], cursor: '57',
        reads: [{ thread_key: 'main', read_seq: mainRead }, { thread_key: root.id, read_seq: threadRead, following }] } };
      if (route.endsWith('/members')) return { body: [] };
      if (route.endsWith(`/messages/${root.id}`)) return { body: root };
      if (route.includes('threadRootId=')) return { body: [reply] };
      if (route.startsWith('/changes?')) return { body: { cursor: '57', changes: [], hasMore: false } };
      return response(route);
    });
    await timed(() => service.getGroup(rooms[0]));
    const result = await timed(() => action === 'main'
      ? service.chatServer!.manage({ groupId: rooms[0], action: { type: 'read', messageId: root.id } })
      : action === 'thread' ? service.chatServer!.thread({ groupId: rooms[0], rootId: root.id, markRead: true })
        : service.chatServer!.followThread({ groupId: rooms[0], rootId: root.id, following: true }));
    expect(result.value.ok).toBe(true);
    await timed(() => service.getGroup(rooms[0]));
    expect(disk.get(rooms[0])?.snapshot).toMatchObject({ reads: [
      { thread_key: 'main', read_seq: action === 'main' ? '1' : '0' },
      { thread_key: root.id, read_seq: action === 'thread' ? '2' : '0', following: action === 'follow' },
    ] });
  });

  it('opens a group in three request rounds and a followed group in two', async () => {
    const firstOpen = await timed(() => service.getGroup(rooms[0]));
    await warm();
    const firstVisit = await timed(() => service.getGroup(rooms[1]));
    await warm();
    const revisit = await timed(() => service.getGroup(rooms[0]));
    await warm();
    const firstList = await timed(() => service.listGroups());
    await warm();
    const nextList = await timed(() => service.listGroups());
    // Before: 800 / 500 / 500 / 400 / 400 ms, every open reading snapshot → messages →
    // executions → failures → plans one after another.
    console.info(`[group-open-latency] ${JSON.stringify({ firstOpenMs: firstOpen.ms, firstVisitMs: firstVisit.ms, revisitMs: revisit.ms,
      firstSidebarListMs: firstList.ms, nextSidebarListMs: nextList.ms, revisitRequests: revisit.routes.length })}`);
    expect([firstOpen, firstVisit, revisit, firstList, nextList].every(read => read.value.ok)).toBe(true);
    expect(firstVisit.ms).toBe(300);
    expect(revisit.ms).toBe(200);
    expect(nextList.ms).toBe(300);
    // Shorter, not more: the same five reads per open.
    expect(revisit.routes).toHaveLength(5);
  });

  it('answers a send after one parallel read round and its post', async () => {
    await timed(() => service.getGroup(rooms[0]));
    await warm();
    fixture.handle.mockImplementation((route, method) => route.endsWith('/messages') && method === 'POST'
      ? { body: { id: '50000000-0000-4000-8000-000000000099' } } : route.endsWith('/members') ? { body: [] } : response(route));
    const plain = await timed(() => service.sendMessage({ groupId: rooms[0], text: 'hello', clientId: 'open-latency-send-1', mentions: { all: false, botIds: [] } }));
    const everyone = await timed(() => service.sendMessage({ groupId: rooms[0], text: 'hello all', clientId: 'open-latency-send-2', mentions: { all: true, botIds: [] } }));
    // Before: snapshot → plans → members → post, one after another (400ms each).
    console.info(`[group-send-latency] ${JSON.stringify({ plainMs: plain.ms, everyoneMs: everyone.ms, plainRequests: plain.routes.length, everyoneRequests: everyone.routes.length })}`);
    expect([plain.value, everyone.value]).toEqual([{ ok: true, messageId: '50000000-0000-4000-8000-000000000099' }, { ok: true, messageId: '50000000-0000-4000-8000-000000000099' }]);
    expect(plain.ms).toBe(200);
    expect(everyone.ms).toBe(200);
    // An unaddressed message needs no member read.
    expect(plain.routes).toHaveLength(3);
    expect(everyone.routes).toHaveLength(4);
  });

  it('starts a claimed turn after one parallel read round and one lease check', async () => {
    service.dispose();
    const botActor = '20000000-0000-4000-8000-000000000001';
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: rooms[0], source_message_id: message.id, bot_id: botActor,
      context_seq: '1', epoch: 1, status: 'running', access_mode: 'chat', access_revision: 1 };
    let queued = true;
    let claimedAt = 0;
    let dispatchedAt = 0;
    fixture.handle.mockImplementation(route => {
      if (route === '/actors') return { body: [{ id: botActor, kind: 'bot', externalId: 'local-bot', name: 'Bot' }] };
      if (route === '/executions/claim') {
        if (!queued) return { body: { execution: null } };
        // Served and answered at once: this is when the claim reaches the client.
        queued = false; claimedAt = Date.now();
        return { body: { execution } };
      }
      return response(route);
    });
    service = withChatServer(local as unknown as BotGroupChatService, { onChanged,
      ensureLane: async () => ({ ok: true, sessionId: 'lane' }), abortLane: async () => {},
      dispatch: async () => { dispatchedAt = Date.now(); return { ok: true }; } } as unknown as BotGroupChatServiceDeps);
    await vi.advanceTimersByTimeAsync(3000);
    // Before: snapshot → lease check → history → lease check → dispatch (400ms after the claim).
    console.info(`[group-pickup-latency] ${JSON.stringify({ afterClaimMs: dispatchedAt - claimedAt })}`);
    expect(dispatchedAt).toBeGreaterThan(0);
    expect(dispatchedAt - claimedAt).toBe(200);
  });

  it('reads a new room only after the snapshot whose cursor it follows from', async () => {
    await warm();
    const from = fixture.routes.length;
    let snapshotAnswered = false;
    fixture.handle.mockImplementation(route => {
      if (route.endsWith('/snapshot')) snapshotAnswered = true;
      return response(route);
    });
    const early: string[] = [];
    const watch = setInterval(() => { if (!snapshotAnswered) early.push(...fixture.routes.slice(from)); }, 1);
    await timed(() => service.getGroup(rooms[2]));
    clearInterval(watch);
    expect(early.filter(route => !route.startsWith('/executions/') && !route.endsWith('/snapshot'))).toEqual([]);
  });

  it('follows a newly opened room from its snapshot cursor and resumes after the last acked cursor', async () => {
    await connected();
    await timed(() => service.getGroup(rooms[0]));
    expect(sent()).toContainEqual({ type: 'subscribe', scope: `conversation:${rooms[0]}`, after: '57' });
    fixture.sockets[0].emit('message', JSON.stringify({ type: 'changes', scope: `conversation:${rooms[0]}`, cursor: '58', changes: [] }));
    vi.mocked(fixture.sockets[0].send).mockClear();
    onChanged.mockClear();
    fixture.sockets[0].emit('message', JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toContainEqual({ type: 'subscribe', scope: `conversation:${rooms[0]}`, after: '58' });
    // A reconnect still re-reads every followed room once, after the 150ms coalescing window.
    await vi.advanceTimersByTimeAsync(150);
    expect(onChanged).toHaveBeenCalledWith({ groupId: rooms[0], change: 'messages' }, undefined);
  });

  it('keeps the membership answer when a parallel read of a followed room fails first', async () => {
    await timed(() => service.getGroup(rooms[0]));
    await warm();
    fixture.handle.mockImplementation(route => route.endsWith('/snapshot') ? { status: 404, body: { error: { code: 'CONVERSATION_NOT_FOUND' } } }
      : route.includes('/messages?') ? { status: 403, body: { error: { code: 'FORBIDDEN' } } } : response(route));
    fixture.timing = route => route.endsWith('/snapshot') ? { serve: 80, deliver: 80 } : { serve: 10, deliver: 10 };
    const left = await timed(() => service.getGroup(rooms[0]));
    expect(left.value).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('reports the first failure in the former read order, not the fastest one', async () => {
    await timed(() => service.getGroup(rooms[0]));
    await warm();
    fixture.handle.mockImplementation(route => route.includes('/messages?') ? { status: 403, body: { error: { code: 'FORBIDDEN' } } }
      : route.endsWith('/executions') ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } } : response(route));
    fixture.timing = route => route.includes('/messages?') ? { serve: 90, deliver: 90 } : { serve: 10, deliver: 10 };
    const denied = await timed(() => service.getGroup(rooms[0]));
    // Serially, messages failed before executions was ever requested.
    expect(denied.value).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('re-reads a room once for a page of attachments instead of once per file', async () => {
    const media = Array.from({ length: 20 }, (_, index) => ({ ...message, id: `50000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      content: [{ type: 'media', mediaId: `60000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}` }] }));
    fixture.page = media;
    fixture.download.mockImplementation((_room: string, mediaId: string) => new Promise(resolve => setTimeout(
      () => resolve({ id: mediaId, name: 'image.png', category: 'image', path: '/test/image.png', url: null }), 10 + Number(mediaId.slice(-2)) * 5)));
    await timed(() => service.getGroup(rooms[0]));
    onChanged.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChanged.mock.calls.filter(([payload]) => payload.groupId === rooms[0])).toHaveLength(1);
    const reread = await timed(() => service.getGroup(rooms[0]));
    expect(reread.value.ok && reread.value.group.messages.every(item => item.attachments.length === 1)).toBe(true);
  });

  // Unit regression: getGroup kept an image's now-deleted local URL forever after manual
  // cleanup. Existing attachment tests only retried failed transfers, not successful copies
  // invalidated by cleanup. Minimum input: one image, one PDF and a cache-generation change.
  it('reloads only image attachments after their dedicated cache is cleared', async () => {
    const mediaId = '60000000-0000-4000-8000-000000000201';
    const fileId = '60000000-0000-4000-8000-000000000202';
    const file = { id: fileId, name: 'report.pdf', category: 'file', path: '/test/report.pdf', url: null };
    fixture.page = [{ ...message, content: [mediaId, fileId].map(mediaId => ({ type: 'media', mediaId })) }];
    let hash = 'a';
    fixture.download.mockImplementation(async (_room: string, id: string) => id === fileId ? file
      : { id, name: 'image.png', category: 'image', path: null, url: `cindy-media://blobs/${hash.repeat(64)}.png` });
    await timed(() => service.getGroup(rooms[0]));
    const loaded = await timed(() => service.getGroup(rooms[0]));
    expect(loaded.value.ok && loaded.value.group.messages[0].attachments[0].url).toContain('a'.repeat(64));
    expect(fixture.download).toHaveBeenCalledTimes(2);
    fixture.cacheGeneration++;
    hash = 'b';
    await timed(() => service.getGroup(rooms[0]));
    const reloaded = await timed(() => service.getGroup(rooms[0]));
    expect(reloaded.value.ok && reloaded.value.group.messages[0].attachments[0].url).toContain('b'.repeat(64));
    expect(reloaded.value.ok && reloaded.value.group.messages[0].attachments[1]).toEqual(file);
    expect(fixture.download.mock.calls.map(([, id]) => id)).toEqual([mediaId, fileId, mediaId]);
  });

  // PR #7442: cleanup must not duplicate or discard a pending ordinary file transfer.
  // Unit, minimum input: one PDF still downloading when the image generation changes.
  it('keeps a pending ordinary attachment projection across image cleanup', async () => {
    const mediaId = '60000000-0000-4000-8000-000000000202';
    const file = { id: mediaId, name: 'report.pdf', category: 'file', path: '/test/report.pdf', url: null };
    let complete!: (value: typeof file) => void;
    fixture.download.mockReturnValue(new Promise<typeof file>(resolve => { complete = resolve; }));
    fixture.page = [{ ...message, content: [{ type: 'media', mediaId }] }];
    await timed(() => service.getGroup(rooms[0]));
    fixture.cacheGeneration++;
    await timed(() => service.getGroup(rooms[0]));
    expect(fixture.download).toHaveBeenCalledTimes(1);
    complete(file);
    const loaded = await timed(() => service.getGroup(rooms[0]));
    expect(loaded.value.ok && loaded.value.group.messages[0].attachments[0]).toEqual(file);
  });

  // Unit timing regression: preserving pending files must not retain a late image URL.
  // Existing settled-image coverage cannot exercise cleanup before download completion.
  it('retries a pending image immediately when it completes after cleanup', async () => {
    const mediaId = '60000000-0000-4000-8000-000000000201';
    const image = { id: mediaId, name: 'image.png', category: 'image', path: null,
      url: `cindy-media://blobs/${'a'.repeat(64)}.png` };
    let complete!: (value: typeof image) => void;
    fixture.download.mockReturnValueOnce(new Promise<typeof image>(resolve => { complete = resolve; }))
      .mockResolvedValue({ ...image, url: `cindy-media://blobs/${'b'.repeat(64)}.png` });
    fixture.page = [{ ...message, content: [{ type: 'media', mediaId }] }];
    await timed(() => service.getGroup(rooms[0]));
    fixture.cacheGeneration++;
    complete(image);
    const retrying = await timed(() => service.getGroup(rooms[0]));
    expect(retrying.value.ok && retrying.value.group.messages[0].attachments[0].url).not.toBe(image.url);
    const loaded = await timed(() => service.getGroup(rooms[0]));
    expect(loaded.value.ok && loaded.value.group.messages[0].attachments[0].url).toContain('b'.repeat(64));
    expect(fixture.download).toHaveBeenCalledTimes(2);
  });

  // Unit: cleanup-fenced reads must recover at cleanup completion, not wait 30s.
  // Existing timing coverage only changes generation before a download settles.
  it('retries an image rejected during cleanup as soon as its generation changes', async () => {
    const mediaId = '60000000-0000-4000-8000-000000000201';
    fixture.page = [{ ...message, content: [{ type: 'media', mediaId }] }];
    fixture.download.mockRejectedValueOnce(new Error('REMOTE_MEDIA_CACHE_CLEARED'))
      .mockResolvedValue({ id: mediaId, name: 'image.png', category: 'image', path: null,
        url: `cindy-media://blobs/${'a'.repeat(64)}.png` });
    await timed(() => service.getGroup(rooms[0]));
    await timed(() => service.getGroup(rooms[0]));
    expect(fixture.download).toHaveBeenCalledTimes(1);
    fixture.cacheGeneration++;
    await timed(() => service.getGroup(rooms[0]));
    const loaded = await timed(() => service.getGroup(rooms[0]));
    expect(loaded.value.ok && loaded.value.group.messages[0].attachments[0].url).toContain('a'.repeat(64));
    expect(fixture.download).toHaveBeenCalledTimes(2);
  });

  it('keeps attachment order, failures and a later retry when completions share one re-read', async () => {
    const ids = ['60000000-0000-4000-8000-000000000201', '60000000-0000-4000-8000-000000000202', '60000000-0000-4000-8000-000000000203'];
    fixture.page = [{ ...message, content: [{ type: 'text', text: 'three files' }, ...ids.map(mediaId => ({ type: 'media', mediaId }))] }];
    const attachment = (mediaId: string) => ({ id: mediaId, name: `${mediaId.slice(-3)}.png`, category: 'image', path: `/test/${mediaId.slice(-3)}.png`, url: null });
    let secondFails = true;
    fixture.download.mockImplementation((_room: string, mediaId: string) => new Promise((resolve, reject) => setTimeout(() => {
      if (mediaId === ids[1] && secondFails) reject(new Error('OBJECT_STORE_UNAVAILABLE'));
      else resolve(attachment(mediaId));
      // The last finishes first: order must come from the message, not from completion.
    }, mediaId === ids[2] ? 10 : mediaId === ids[1] ? 40 : 60)));
    await timed(() => service.getGroup(rooms[0]));
    onChanged.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    // Two successes and one failure settle inside one window: one re-read shows their states.
    expect(onChanged.mock.calls.filter(([payload]) => payload.groupId === rooms[0])).toHaveLength(1);
    const settled = await timed(() => service.getGroup(rooms[0]));
    // Every media block keeps its slot in message order; the failed one says so instead of vanishing.
    expect(settled.value.ok && settled.value.group.messages[0].attachments.map(item => [item.id, item.state ?? 'ready']))
      .toEqual([[ids[0], 'ready'], [ids[1], 'unavailable'], [ids[2], 'ready']]);
    // A failed file is not retried during its backoff, then is retried by the next read.
    expect(fixture.download).toHaveBeenCalledTimes(3);
    secondFails = false;
    await vi.advanceTimersByTimeAsync(30_000);
    onChanged.mockClear();
    await timed(() => service.getGroup(rooms[0]));
    expect(fixture.download).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChanged.mock.calls.filter(([payload]) => payload.groupId === rooms[0])).toHaveLength(1);
    const recovered = await timed(() => service.getGroup(rooms[0]));
    expect(recovered.value.ok && recovered.value.group.messages[0].attachments.map(item => [item.id, item.state ?? 'ready']))
      .toEqual(ids.map(mediaId => [mediaId, 'ready']));
  });

  it('notifies again for an attachment that settles after a coalesced re-read was sent', async () => {
    const ids = ['60000000-0000-4000-8000-000000000301', '60000000-0000-4000-8000-000000000302'];
    fixture.page = [{ ...message, content: ids.map(mediaId => ({ type: 'media', mediaId })) }];
    fixture.download.mockImplementation((_room: string, mediaId: string) => new Promise(resolve => setTimeout(
      () => resolve({ id: mediaId, name: 'late.png', category: 'image', path: '/test/late.png', url: null }), mediaId === ids[0] ? 10 : 900)));
    await timed(() => service.getGroup(rooms[0]));
    onChanged.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChanged.mock.calls.filter(([payload]) => payload.groupId === rooms[0])).toHaveLength(2);
    const read = await timed(() => service.getGroup(rooms[0]));
    expect(read.value.ok && read.value.group.messages[0].attachments.map(item => item.id)).toEqual(ids);
  });

  describe('attachment notices across the coalescing window', () => {
    const media = (index: number) => `60000000-0000-4000-8000-0000000004${String(index).padStart(2, '0')}`;
    const attachment = (mediaId: string) => ({ id: mediaId, name: 'file.png', category: 'image', path: '/test/file.png', url: null });
    /** Downloads settle at the given ms after the first read; returns their settle times. */
    function scheduleDownloads(plan: Array<{ at: number; fails?: boolean }>) {
      fixture.page = [{ ...message, content: plan.map((_, index) => ({ type: 'media', mediaId: media(index) })) }];
      const settled: number[] = [];
      fixture.download.mockImplementation((_room: string, mediaId: string) => {
        const step = plan[Number(mediaId.slice(-2))]!;
        return new Promise((resolve, reject) => setTimeout(() => {
          settled.push(Date.now());
          if (step.fails) reject(new Error('OBJECT_STORE_UNAVAILABLE')); else resolve(attachment(mediaId));
        }, step.at));
      });
      return settled;
    }
    let notices: number[] = [];
    beforeEach(() => {
      notices = [];
      onChanged.mockImplementation((payload: { groupId: string }) => { if (payload.groupId === rooms[0]) notices.push(Date.now()); });
    });

    it.each([
      ['the last one succeeds', false],
      ['the last one fails', true],
    ])('delivers a notice after every settle when %s, across the window boundary', async (_name, lastFails) => {
      // The last settle lands inside the window opened by the one before it.
      const settled = scheduleDownloads([{ at: 0 }, { at: 150 }, { at: 199 }, { at: 200 }, { at: 201 }, { at: 399 }, { at: 650 }, { at: 700, fails: lastFails }]);
      await timed(() => service.getGroup(rooms[0]));
      notices = [];
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toHaveLength(8);
      // No settle is left without a later notice, so the last state is always re-read.
      for (const at of settled) expect(notices.some(time => time >= at)).toBe(true);
      expect(Math.max(...notices)).toBeGreaterThanOrEqual(Math.max(...settled));
      expect(notices.length).toBeLessThan(settled.length);
      const read = await timed(() => service.getGroup(rooms[0]));
      // Eight slots either way; a failed last download is shown as unavailable, not dropped.
      const attachments = read.value.ok ? read.value.group.messages[0].attachments : [];
      expect(attachments).toHaveLength(8);
      expect(attachments.map(item => item.state ?? 'ready')).toEqual([...Array(7).fill('ready'), lastFails ? 'unavailable' : 'ready']);
    });

    it('re-reads again when a download settles while the previous refresh is still in flight', async () => {
      scheduleDownloads([{ at: 0 }, { at: 260 }]);
      await timed(() => service.getGroup(rooms[0]));
      // Each notice starts a refresh, as the group page does; the newest answer is shown.
      let shown: string[] = [];
      let version = 0;
      onChanged.mockImplementation((payload: { groupId: string }) => {
        if (payload.groupId !== rooms[0]) return;
        notices.push(Date.now());
        const current = ++version;
        void service.getGroup(rooms[0]).then(result => {
          if (current === version && result.ok) shown = result.group.messages[0].attachments.map(item => item.id);
        });
      });
      await vi.advanceTimersByTimeAsync(3000);
      // The first refresh (sent at ~200ms, reads ~200ms) was in flight when the second file settled.
      expect(notices.length).toBe(2);
      expect(shown).toEqual([media(0), media(1)]);
    });

    it('keeps notices per group', async () => {
      fixture.page = [{ ...message, content: [{ type: 'media', mediaId: media(0) }] }];
      fixture.download.mockImplementation((_room: string, mediaId: string) => new Promise(resolve => setTimeout(() => resolve(attachment(mediaId)), 50)));
      await Promise.all([timed(() => service.getGroup(rooms[0])), timed(() => service.getGroup(rooms[1]))]);
      onChanged.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      const groups = onChanged.mock.calls.map(([payload]) => payload.groupId);
      expect(groups.filter(id => id === rooms[0])).toHaveLength(1);
      expect(groups.filter(id => id === rooms[1])).toHaveLength(1);
    });

    it('drops a pending notice of the previous account after a switch', async () => {
      service.dispose();
      let epoch = 0;
      const ownerChanged = vi.fn();
      service = withChatServer(local as unknown as BotGroupChatService, {
        captureOwnerScope: () => ({ epoch }),
        isOwnerScopeCurrent: (scope: { epoch: number }) => scope.epoch === epoch,
        onChanged: ownerChanged,
      } as unknown as BotGroupChatServiceDeps);
      scheduleDownloads([{ at: 0 }, { at: 100 }]);
      await timed(() => service.getGroup(rooms[0]));
      await vi.advanceTimersByTimeAsync(50);
      ownerChanged.mockClear();
      epoch += 1;
      await vi.advanceTimersByTimeAsync(2000);
      expect(ownerChanged).not.toHaveBeenCalled();
    });
  });

  it('does not summarize every local history to open a server room', async () => {
    await timed(() => service.getGroup(rooms[0]));
    expect(local.listGroups).not.toHaveBeenCalled();
    fixture.localGroupIds = [rooms[1]];
    await warm();
    await timed(() => service.getGroup(rooms[1]));
    expect(local.listGroups).toHaveBeenCalled();
  });
});

describe('Chat Server realtime cursor against a server model', () => {
  const roomId = rooms[0];
  const peer = '30000000-0000-4000-8000-000000000002';
  let service: BotGroupChatService;
  let head = 0;
  let history: Array<Record<string, unknown>> = [];
  /** Per socket: the subscription cursor and the batch awaiting its ack, as realtime.ts keeps them. */
  const subscriptions = new Map<unknown, Map<string, { cursor: number; pending?: number }>>();
  /** The renderer's rule: the newest request wins, a failed refresh keeps what is shown. */
  let shown: string[] = [];
  let requestVersion = 0;
  const show = () => {
    const version = ++requestVersion;
    void service.getGroup(roomId).then(result => {
      if (version === requestVersion && result.ok) shown = result.group.messages.map(item => item.content);
    });
  };
  const commit = (text: string) => {
    head += 1;
    history.push({ id: `50000000-0000-4000-8000-${String(head).padStart(12, '0')}`, seq: String(head), authorId: peer, author: { kind: 'human', name: 'Peer' },
      content: [{ type: 'text', text }], createdAt: '2026-10-03T00:00:00Z', deleted: false, threadRootId: null });
  };
  const socket = () => fixture.sockets.at(-1)!;
  /** One realtime poll: each idle subscription behind the head receives one batch. */
  const pump = () => {
    for (const [scope, entry] of subscriptions.get(socket()) ?? []) {
      if (entry.pending !== undefined || entry.cursor >= head) continue;
      entry.pending = head;
      socket().emit('message', JSON.stringify({ type: 'changes', scope, cursor: String(head), changes: [{ type: 'message.created' }] }));
    }
  };
  const ready = () => socket().emit('message', JSON.stringify({ type: 'ready' }));
  const subscribeFrames = () => fixture.sockets.flatMap(item => vi.mocked(item.send).mock.calls.map(([frame]) => JSON.parse(String(frame))))
    .filter(frame => frame.type === 'subscribe' && frame.scope === `conversation:${roomId}`);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.routes = []; fixture.sockets = []; fixture.profiles = []; fixture.localGroupIds = []; fixture.latencyMs = 20;
    fixture.timing = null; fixture.offline = false;
    head = 0; history = []; shown = []; requestVersion = 0; subscriptions.clear();
    for (const text of ['one', 'two', 'three']) commit(text);
    fixture.onFrame = (owner, frame) => {
      const scopes = subscriptions.get(owner) ?? new Map();
      subscriptions.set(owner, scopes);
      if (frame.type === 'subscribe') scopes.set(String(frame.scope), { cursor: Number(frame.after) });
      if (frame.type === 'ack') {
        const entry = scopes.get(String(frame.scope));
        if (entry?.pending === Number(frame.cursor)) { entry.cursor = entry.pending; entry.pending = undefined; }
      }
    };
    fixture.handle.mockImplementation(route => {
      if (route.endsWith('/snapshot')) return { body: { room: room(roomId), members: [], messages: [...history].reverse().slice(0, 100), cursor: String(head) } };
      if (route.includes('/messages?')) return { body: [...history].reverse().slice(0, 100) };
      return response(route);
    });
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() } as unknown as BotGroupChatService,
      { onChanged: vi.fn(payload => { if (payload.groupId === roomId) show(); }) } as unknown as BotGroupChatServiceDeps);
    await vi.advanceTimersByTimeAsync(2500);
    ready();
    show();
    await vi.advanceTimersByTimeAsync(500);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('shows a change that a parallel read missed, even when its refresh fails during a disconnect', async () => {
    expect(shown).toEqual(['one', 'two', 'three']);
    expect(subscribeFrames()).toEqual([{ type: 'subscribe', scope: `conversation:${roomId}`, after: '3' }]);
    // A followed room: messages are read before "four" commits, the snapshot after it.
    fixture.timing = route => route.endsWith('/snapshot') ? { serve: 90, deliver: 100 } : { serve: 10, deliver: 20 };
    show();
    setTimeout(() => commit('four'), 50);
    await vi.advanceTimersByTimeAsync(200);
    expect(shown).toEqual(['one', 'two', 'three']);
    // The change arrives, but its refresh fails and the connection drops before any re-read.
    fixture.offline = true;
    pump();
    socket().emit('close');
    await vi.advanceTimersByTimeAsync(200);
    expect(shown).not.toContain('four');
    fixture.offline = false;
    fixture.timing = null;
    await vi.advanceTimersByTimeAsync(600);
    expect(fixture.sockets).toHaveLength(2);
    ready();
    await vi.advanceTimersByTimeAsync(500);
    // Resumes after what was read, without replaying the history, and re-reads the room.
    expect(subscribeFrames().at(-1)).toEqual({ type: 'subscribe', scope: `conversation:${roomId}`, after: '4' });
    expect(shown).toEqual(['one', 'two', 'three', 'four']);
    commit('five');
    pump();
    await vi.advanceTimersByTimeAsync(500);
    expect(shown).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('follows a new room from the first snapshot answer and never rewinds to a late older one', async () => {
    service.dispose();
    fixture.sockets = []; subscriptions.clear(); shown = [];
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() } as unknown as BotGroupChatService,
      { onChanged: vi.fn(payload => { if (payload.groupId === roomId) show(); }) } as unknown as BotGroupChatServiceDeps);
    await vi.advanceTimersByTimeAsync(2500);
    ready();
    let snapshots = 0;
    // The first snapshot is read at "three" but answers last; the second is read at "four" and answers first.
    fixture.timing = route => {
      if (!route.endsWith('/snapshot')) return { serve: 10, deliver: 20 };
      snapshots += 1;
      return snapshots === 1 ? { serve: 10, deliver: 300 } : { serve: 60, deliver: 100 };
    };
    const results: string[][] = [];
    const read = () => void service.getGroup(roomId).then(result => { if (result.ok) results.push(result.group.messages.map(item => item.content)); });
    read();
    setTimeout(() => commit('four'), 30);
    setTimeout(read, 40);
    await vi.advanceTimersByTimeAsync(600);
    expect(subscribeFrames()).toEqual([{ type: 'subscribe', scope: `conversation:${roomId}`, after: '4' }]);
    expect(results).toEqual([['one', 'two', 'three', 'four'], ['one', 'two', 'three', 'four']]);
    fixture.timing = null;
    socket().emit('close');
    await vi.advanceTimersByTimeAsync(600);
    ready();
    expect(subscribeFrames().at(-1)).toEqual({ type: 'subscribe', scope: `conversation:${roomId}`, after: '4' });
    commit('five');
    pump();
    await vi.advanceTimersByTimeAsync(500);
    expect(shown.at(-1)).toBe('five');
  });

  it('starts a new room from a stale cursor only through the server reset path', async () => {
    // A cursor below the server floor answers RESET_REQUIRED; the room is re-read from a new snapshot.
    commit('four');
    socket().emit('message', JSON.stringify({ type: 'scope_error', scope: `conversation:${roomId}`, error: { code: 'RESET_REQUIRED' } }));
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribeFrames().at(-1)).toEqual({ type: 'subscribe', scope: `conversation:${roomId}`, after: '4' });
    expect(shown).toEqual(['one', 'two', 'three', 'four']);
  });
});

