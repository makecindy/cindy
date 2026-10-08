import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: fixture.download }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
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
      if (route === '/conversations?limit=100') return { body: [{ id: roomId, state: 'joined' }] };
      if (route === '/executions/claim') return { body: { execution: null } };
      if (route.endsWith('/snapshot')) return { body: {
        room: { id: roomId, name: 'Group', response_mode: 'all', speaking_mode: 'auto',
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
    expect(changed).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.handle.mock.calls.some(([route, method]) => method === 'POST' && route.includes('/messages'))).toBe(false);
  });

  it('never continues a discussion from an admission event', async () => {
    expect((await service.continueRound(roomId)).ok).toBe(false);
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/continue'))).toBe(false);
  });
});
