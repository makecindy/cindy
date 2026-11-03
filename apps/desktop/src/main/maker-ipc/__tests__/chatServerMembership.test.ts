import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: fixture.download }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
// These transport/lifecycle fixtures isolate native disk IO; actual snapshot and
// journal persistence is exercised through chatPersistence.test.ts and chatServer.test.ts.
vi.mock('../chatLocalHistory.js', () => ({ chatLocalHistory: () => ({ read: () => null, save: vi.fn(), forget: vi.fn() }) }));
vi.mock('../chatSendJournal.js', () => ({ chatSendJournal: () => ({ read: () => null, save: vi.fn(), confirm: vi.fn(), forgetRoom: vi.fn() }) }));
vi.mock('electron', () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists, readFileSync: () => fixture.config || '{"baseUrl":"https://example.com","token":"test"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), { limit: async () => [{ id: 'existing-local-group' }] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string }, callback: (response: unknown) => void) => {
    fixture.urls.push(String(url));
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        void Promise.resolve().then(() => fixture.handle(new URL(url).pathname.slice(3) + new URL(url).search, options.method, data ? JSON.parse(data) : undefined))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200 });
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
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
    static OPEN = 1; readyState = 0; send = vi.fn();
    constructor(url: URL) { super(); fixture.wsUrls.push(String(url)); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('Chat Server membership notices', () => {
  const roomId = '10000000-0000-4000-8000-000000000001';
  const memberId = '20000000-0000-4000-8000-000000000001';
  const selfId = '30000000-0000-4000-8000-000000000001';
  const joined = () => ({ id: '40000000-0000-4000-8000-000000000001', seq: '12', origin: 'system',
    authorId: memberId, author: { kind: 'human', name: 'Current profile name' },
    content: [{ type: 'card', namespace: 'cindy.membership', schemaRevision: 1,
      fallback: 'Taylor joined the group', data: { type: 'member.joined', actorId: memberId, displayName: 'Taylor' } }],
    threadRootId: null, deleted: false, createdAt: '2026-10-08T00:00:00Z' });
  let messages: ReturnType<typeof joined>[];
  let service: BotGroupChatService;
  const dispatch = vi.fn();
  const changed = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.packaged = true; fixture.profiles = []; fixture.sockets = []; fixture.urls = [];
    messages = [joined()];
    fixture.handle.mockImplementation(route => {
      if (route === '/me') return { body: { actor: { id: selfId } } };
      if (route === '/conversations?limit=100') return { body: [{ id: roomId, kind: 'group', state: 'joined' }] };
      if (route === '/executions/claim') return { body: { execution: null } };
      if (route.endsWith('/snapshot')) return { body: {
        room: { id: roomId, kind: 'group', name: 'Group', response_mode: 'all', speaking_mode: 'auto',
          created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z' },
        members: [{ id: memberId, kind: 'human', name: 'Renamed after joining', state: 'left', ownerActorId: memberId, ownerName: '' }],
        messages, cursor: '12',
      } };
      if (route.includes('/messages?')) return { body: messages };
      return { body: [] };
    });
    service = withChatServer({ dispose: vi.fn(), listGroups: async () => ({ ok: true, groups: [] }) } as unknown as BotGroupChatService,
      { dispatch, onChanged: changed } as unknown as BotGroupChatServiceDeps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.clearAllMocks(); });

  it('records the displayed main message using its exact server position and reflects another device read', async () => {
    const seq = '9007199254740993';
    messages = [{ ...joined(), origin: 'human', seq, content: [{ type: 'text', text: '**Hello** [team](https://example.com)' }] } as unknown as ReturnType<typeof joined>];
    let readSeq = '0';
    const original = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, body) => {
      if (route.endsWith('/read')) { readSeq = body.readSeq; return { body: { readSeq } }; }
      const response = original(route, method, body);
      if (route.endsWith('/snapshot')) response.body.reads = [{ thread_key: 'main', read_seq: readSeq }];
      return response;
    });
    const before = await service.getGroup(roomId);
    expect(before.ok && before.group.serverUnread).toEqual({ count: 1, mentioned: false });
    expect(before.ok && before.group.lastMessage?.preview).toBe('Hello team');
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'read', messageId: messages[0]!.id } })).toEqual({ ok: true });
    expect(fixture.handle).toHaveBeenCalledWith(`/conversations/${roomId}/read`, 'POST', { operationId: `read-main:${seq}`, readSeq: seq });
    const after = await service.getGroup(roomId);
    expect(after.ok && after.group.serverUnread).toEqual({ count: 0, mentioned: false });
  });

  it('reads a persisted join into the main timeline and sidebar using its name snapshot', async () => {
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.messages).toEqual([expect.objectContaining({
      id: joined().id, sequence: 12, kind: 'notice', authorKind: 'system', noticeCode: 'member-joined',
      authorName: 'Taylor', authorBotId: null, isSelf: false, threadRootId: null, planId: null,
    })]);
    expect(result.ok && result.group.lastMessage).toMatchObject({ authorKind: 'system', authorName: 'Taylor', noticeCode: 'member-joined' });
    expect(result.ok && result.group.round.canContinue).toBe(false);
    expect(result.ok && result.group.lastReplyAt).toBe(0);
  });

  it('preserves an incoming reply timestamp behind a later admission event', async () => {
    const replyAt = '2026-10-07T23:59:00Z';
    messages = [joined(), { ...joined(), id: '40000000-0000-4000-8000-000000000002',
      seq: '11', origin: 'user', createdAt: replyAt }];
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.lastReplyAt).toBe(Date.parse(replyAt));
  });

  it('uses the latest visible topic activity for the sidebar, not snapshot array order or a deleted message', async () => {
    const topic = { ...joined(), id: '40000000-0000-4000-8000-000000000002', seq: '9007199254740993',
      origin: 'user', threadRootId: joined().id, createdAt: '2026-10-09T00:00:00Z',
      content: [{ type: 'text', text: 'Latest topic reply' }] } as unknown as ReturnType<typeof joined>;
    messages = [joined(), { ...joined(), seq: '9007199254740994', deleted: true }, topic];
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.lastMessage).toMatchObject({ preview: 'Latest topic reply', createdAt: Date.parse(topic.createdAt) });
  });

  it('keeps separate admissions for the same member after leaving and rejoining', async () => {
    messages = [{ ...joined(), id: '40000000-0000-4000-8000-000000000002', seq: '20' }, joined()];
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.messages.map(m => [m.sequence, m.authorName])).toEqual([[12, 'Taylor'], [20, 'Taylor']]);
  });

  it.each(['user', 'bot', 'integration', 'import'])('does not trust a membership card from %s', async origin => {
    messages = [{ ...joined(), origin, authorId: memberId, author: { kind: 'human', name: 'Taylor' } }];
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.messages[0]).toMatchObject({ kind: 'message', noticeCode: null, authorKind: 'user' });
  });

  it.each(['unknown-version', 'invalid-subject', 'unknown-event', 'deleted'])('uses the system fallback for %s', async change => {
    const message = joined();
    if (change === 'unknown-version') message.content[0]!.schemaRevision = 2;
    if (change === 'invalid-subject') message.content[0]!.data.actorId = 'invalid';
    if (change === 'unknown-event') message.content[0]!.data.type = 'member.left';
    if (change === 'deleted') message.deleted = true;
    messages = [message];
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.messages[0]).toMatchObject({ kind: 'notice', authorKind: 'system', noticeCode: null });
  });

  it('re-reads the same persisted record after duplicate changes and reconnect without sending or dispatching', async () => {
    await service.getGroup(roomId);
    await vi.advanceTimersByTimeAsync(2000);
    const socket = fixture.sockets[0]!;
    Object.defineProperty(socket, 'readyState', { value: 1 });
    for (const event of [{ type: 'ready' }, { type: 'changes', scope: `conversation:${roomId}`, cursor: '12',
      changes: [{ type: 'message.system.created', entityId: joined().id }] }]) {
      socket.emit('message', JSON.stringify(event));
      socket.emit('message', JSON.stringify(event));
      const result = await service.getGroup(roomId);
      expect(result.ok && result.group.messages.map(m => m.id)).toEqual([joined().id]);
    }
    // Duplicate notices coalesce into one push at the end of the 150ms window.
    await vi.advanceTimersByTimeAsync(150);
    expect(changed).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.handle.mock.calls.some(([route, method]) => method === 'POST' && route.includes('/messages'))).toBe(false);
  });

  it('resyncs personal state and resumes actor events at the reset head', async () => {
    lifecycle();
    let states: unknown[] = [];
    const handle = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.startsWith('/conversation-list-state?') ? { body: states } : handle(route, ...args));
    await service.listGroups();
    await vi.advanceTimersByTimeAsync(2000);
    const socket = fixture.sockets[0]!;
    Object.defineProperty(socket, 'readyState', { value: 1 });
    socket.emit('message', JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    states = [{ conversationId: roomId, hidden: true, revision: 1 }];
    socket.emit('message', JSON.stringify({ type: 'scope_error', scope: `actor:${selfId}`, error: { code: 'RESET_REQUIRED', details: { head: '42' } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', scope: `actor:${selfId}`, after: '42' }));
    expect(await service.listGroups()).toMatchObject({ ok: true, groups: [] });
    expect(changed.mock.calls.map(([payload]) => payload)).toContainEqual(expect.objectContaining({ groupId: roomId, change: 'list', listState: expect.objectContaining({ hidden: true }) }));
    socket.emit('message', JSON.stringify({ type: 'changes', scope: `actor:${selfId}`, cursor: '43', changes: [
      { type: 'conversation.list.changed', data: { conversationId: roomId, hidden: false, revision: 2 } },
    ] }));
    expect((await service.getGroup(roomId)).ok).toBe(true);
  });

  it('never continues a discussion from an admission event', async () => {
    expect((await service.continueRound(roomId)).ok).toBe(false);
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/continue'))).toBe(false);
  });
  function lifecycle(options: { supported?: boolean; kind?: string; role?: string; ownedBot?: boolean; failHide?: boolean; left?: boolean; dissolvedAt?: string } = {}) {
    const previous = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, body) => {
      if (route === '/me') return { body: { actor: { id: selfId }, ...(options.supported === false ? {} : { capabilities: { groupLifecycleVersion: 1, conversationListStateVersion: 1 } }) } };
      if (route.startsWith('/conversation-list-state?')) return { body: [] };
      if (route.endsWith('/list-state')) return options.failHide ? { status: 409, body: { error: { code: 'REVISION_CONFLICT' } } }
        : { body: { conversationId: roomId, hidden: true, revision: 1 } };
      if (route.endsWith('/dissolve')) return { body: { revision: 2, dissolvedAt: '2026-10-15T00:00:00Z', dissolvedBy: selfId } };
      if (route.endsWith('/snapshot')) {
        if (options.left) return { status: 403, body: { error: { code: 'NOT_MEMBER' } } };
        const result = previous(route, method, body);
        result.body.room = { ...result.body.room, kind: options.kind ?? 'group', revision: 1, archived: false, dissolved_at: options.dissolvedAt ?? null };
        result.body.members = [{ id: options.ownedBot ? memberId : selfId, kind: options.ownedBot ? 'bot' : 'human', name: 'Fixture',
          ownerActorId: selfId, state: 'joined', role: options.role ?? 'owner' }];
        return result;
      }
      return previous(route, method, body);
    });
  }
  it('projects dissolved lifecycle and reaction versions together without enabling invitations', async () => {
    const dissolvedAt = '2026-10-15T00:00:00Z';
    lifecycle({ dissolvedAt });
    expect(await service.getGroup(roomId)).toMatchObject({ ok: true, group: {
      archived: false, dissolvedAt, supportsGroupLeave: true, supportsDissolve: true, supportsListRemoval: true,
      canInvite: false, reactionRevision: expect.any(Number), reactionRevisions: {},
    } });
  });
  it('never substitutes archive or delete on an old server', async () => {
    lifecycle({ supported: false });
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'dissolve', expectedRevision: 1 } })).toMatchObject({ ok: false, errorCode: 'LIFECYCLE_UNAVAILABLE' });
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'hide' } })).toMatchObject({ ok: false, errorCode: 'LIFECYCLE_UNAVAILABLE' });
    expect(fixture.handle.mock.calls.some(([route, method]) => method === 'PATCH' || route.endsWith('/dissolve') || route.endsWith('/list-state'))).toBe(false);
  });
  it.each([false, true])('dissolves only a current owned owner (companion=%s), with the edited revision', async ownedBot => {
    lifecycle({ ownedBot });
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'dissolve', expectedRevision: 1 } })).toMatchObject({ ok: true });
    expect(fixture.handle).toHaveBeenCalledWith(`/conversations/${roomId}/dissolve`, 'POST', expect.objectContaining({ expectedRevision: 1, operationId: expect.any(String) }));
    expect(fixture.handle.mock.calls.some(([, method]) => method === 'PATCH')).toBe(false);
  });
  it.each([{ kind: 'direct', code: 'CONVERSATION_NOT_FOUND' }, { role: 'admin', code: 'OWNER_REQUIRED' }, { role: 'member', code: 'OWNER_REQUIRED' }])('refuses invalid dissolution %j', async ({ code, ...options }) => {
    lifecycle(options);
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'dissolve', expectedRevision: 1 } })).toMatchObject({ ok: false, errorCode: code });
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/dissolve'))).toBe(false);
  });
  it('removes personal history after leave without reading or deleting its forbidden snapshot', async () => {
    lifecycle({ left: true });
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'hide' } })).toMatchObject({ ok: true, listState: { conversationId: roomId, hidden: true, revision: 1 } });
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/snapshot'))).toBe(false);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ groupId: roomId, change: 'list', listState: expect.objectContaining({ hidden: true }) }), undefined);
    expect(await service.listGroups()).toMatchObject({ ok: true, groups: [] });
  });
  it('keeps a failed personal removal visible and retryable', async () => {
    lifecycle({ failHide: true });
    expect(await service.chatServer!.manage({ groupId: roomId, action: { type: 'hide' } })).toMatchObject({ ok: false, errorCode: 'REVISION_CONFLICT' });
    expect(changed.mock.calls.some(([event]) => event.change === 'list')).toBe(false);
    expect((await service.getGroup(roomId)).ok).toBe(true);
  });

});
