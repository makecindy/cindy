import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[], token: 'isolated-test-token', refresh: vi.fn(async () => true), requests: [] as Array<{ url: string; token: string }> }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => fixture.token, refresh: fixture.refresh }));
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
  return { request: (url: string, options: { method: string; headers: { Authorization: string } }, callback: (response: unknown) => void) => {
    fixture.urls.push(String(url));
    fixture.requests.push({ url: String(url), token: options.headers.Authorization });
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        void Promise.resolve().then(() => fixture.handle(new URL(url).pathname.slice(3) + new URL(url).search, options.method, data ? JSON.parse(data) : undefined))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200, headers: result?.headers ?? {} });
            callback(response);
            response.emit('data', Buffer.from(result?.rawBody ?? JSON.stringify(result?.body ?? {})));
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
import { authorizeGroupTool } from '../botGroupToolAuthorization.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('Chat Server production connection', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  const local = { dispose: vi.fn() } as unknown as BotGroupChatService;
  const deps = {} as BotGroupChatServiceDeps;
  it('enables the installed application without reading a fixture', async () => {
    fixture.packaged = true;
    const service = withChatServer(local, deps);
    expect(await service.chatServer!.status()).toEqual({ enabled: true, connected: false });
    expect(fixture.exists).not.toHaveBeenCalled();
    service.dispose();
  });
  it('enables an unpackaged application from the same endpoint manifest', async () => {
    fixture.packaged = false; vi.stubEnv('XDT_ISOLATED', '0');
    const service = withChatServer(local, deps);
    expect((await service.chatServer!.status()).enabled).toBe(true);
    service.dispose();
  });
  it('uses HTTPS and WSS in packaged mode without the DEV fixture', async () => {
    vi.useFakeTimers(); fixture.packaged = true; fixture.profiles = []; fixture.urls = []; fixture.wsUrls = [];
    fixture.handle.mockImplementation(route => ({ body: route === '/me' ? { actor: { id: 'self' } } : [] }));
    const service = withChatServer({ ...local, listGroups: async () => ({ ok: true, groups: [] }) }, deps);
    try {
      expect((await service.listGroups()).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fixture.urls.every(url => url.startsWith('https://chat.cindy.app/v1/'))).toBe(true);
      expect(fixture.wsUrls).toEqual(['wss://chat.cindy.app/v1/ws']);
    } finally { service.dispose(); vi.useRealTimers(); }
  });
  it('refuses a fixture that targets an external server', () => {
    fixture.packaged = false; vi.stubEnv('XDT_ISOLATED', '1'); fixture.exists.mockReturnValue(true);
    expect(() => withChatServer(local, deps)).toThrow();
  });
});

describe('Chat Server result delivery and refresh', () => {
  const roomId = '10000000-0000-4000-8000-000000000001';
  const botId = '20000000-0000-4000-8000-000000000001';
  const selfId = '30000000-0000-4000-8000-000000000001';
  const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: roomId,
    source_message_id: '50000000-0000-4000-8000-000000000001', bot_id: botId,
    context_seq: '1', epoch: 1, status: 'running', access_mode: 'chat', access_revision: 1 };
  const room = (id: string) => ({ id, name: 'Room', state: 'joined', response_mode: 'all', speaking_mode: 'auto',
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z', revision: 1, archived: false });
  let service: BotGroupChatService;
  let deps: BotGroupChatServiceDeps;
  let claimed = false;
  function response(route: string) {
    if (route === '/me') return { body: { actor: { id: selfId } } };
    if (route === '/actors') return { body: [{ id: botId, kind: 'bot', externalId: 'local-bot', name: 'Bot' }] };
    if (route === '/executions/claim') {
      const next = claimed ? null : execution; claimed = true;
      return { body: { execution: next } };
    }
    if (route.endsWith('/snapshot')) return { body: { room: room(route.split('/')[2]), members: [], messages: [], cursor: '1' } };
    if (route.includes('/messages?') || route.endsWith('/executions') || route.includes('/plans')) return { body: [] };
    return { body: {} };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    fixture.packaged = false; fixture.exists.mockReturnValue(true); fixture.profiles = []; fixture.sockets = []; claimed = false;
    fixture.config = '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}';
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.handle.mockImplementation(response);
    fixture.token = 'isolated-test-token';
    fixture.refresh.mockReset().mockResolvedValue(true);
    deps = { ensureLane: vi.fn(async () => ({ ok: true, sessionId: 'lane' })), abortLane: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: Parameters<BotGroupChatServiceDeps['dispatch']>[0]) => { await input.onAccepted?.(); return { ok: true }; }),
      onChanged: vi.fn(),
    } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); fixture.config = ''; vi.clearAllMocks(); });
  async function start() {
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  }
  const terminal = { sessionId: 'lane', activeInputClientId: null, outcome: 'done' as const, resultText: 'Finished reply' };
  const deliveries = () => fixture.handle.mock.calls.filter(([, , body]) => body?.action === 'complete');

  it.each([undefined, '60000000-0000-4000-8000-000000000001'])('does not replace execution requester %s with the source author', async requesterId => {
    fixture.handle.mockImplementation((route, method, body) => {
      if (route === '/executions/claim') {
        const next = claimed ? null : { ...execution, requester_id: requesterId, access_mode: 'owner' };
        claimed = true; return { body: { execution: next } };
      }
      if (route.endsWith('/members')) return { body: [
        { id: botId, kind: 'bot', ownerActorId: selfId, state: 'joined', accessRevision: 1, guestAccess: 'tools' },
        { id: selfId, kind: 'human', ownerActorId: selfId, state: 'joined', role: 'owner' },
      ] };
      if (route.endsWith(`/messages/${execution.source_message_id}`) || route.includes('/messages?')) {
        const source = { id: execution.source_message_id, seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' },
          content: [{ type: 'text', text: 'Original owner request' }], deleted: false, threadRootId: null };
        return { body: route.includes('/messages?') ? [source] : source };
      }
      return response(route);
    });
    await start();
    await expect(authorizeGroupTool('lane', 'local-bot', 'owner-action')).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_REQUIRED' });
  });

  it.each(['revision', 'requester', 'companion-owner', 'left', 'lease', 'account', 'restart', 'temporary-members', 'temporary-heartbeat'])(
    'checks the server execution at the tool boundary and rejects %s changes', async change => {
      let changed = false;
      let accountCurrent = true;
      deps.captureOwnerScope = () => ({}) as ReturnType<NonNullable<typeof deps.captureOwnerScope>>;
      deps.isOwnerScopeCurrent = () => accountCurrent;
      service.dispose();
      service = withChatServer({ listGroups: async () => ({ ok: true, groups: [] }), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
      fixture.handle.mockImplementation((route, method, body) => {
        if (route === '/executions/claim') {
          const next = claimed ? null : { ...execution, requester_id: selfId, access_mode: 'owner' };
          claimed = true; return { body: { execution: next } };
        }
        if (changed && (change === 'temporary-members' && route.endsWith('/members')
          || change === 'temporary-heartbeat' && body?.action === 'heartbeat'))
          return { status: 503, body: { error: { code: 'UNAVAILABLE' } } };
        if (route.endsWith('/members')) return { body: [
          { id: botId, kind: 'bot', ownerActorId: changed && change === 'companion-owner' ? 'other-owner' : selfId,
            state: changed && change === 'left' ? 'left' : 'joined', accessRevision: changed && change === 'revision' ? 2 : 1, guestAccess: 'tools' },
          { id: selfId, kind: 'human', state: 'joined', role: 'owner', ownerActorId: changed && change === 'requester' ? 'other-owner' : selfId },
        ] };
        if (changed && change === 'lease' && body?.action === 'heartbeat') return { status: 409, body: { error: { code: 'STALE_EXECUTION' } } };
        return response(route);
      });
      await start();
      await expect(authorizeGroupTool('lane', 'local-bot', 'owner-action')).resolves.toBeDefined();
      expect(fixture.handle.mock.calls.some(([, , body]) => body?.action === 'heartbeat')).toBe(true);
      changed = true;
      if (change === 'account') accountCurrent = false;
      if (change === 'restart') service.dispose();
      await expect(authorizeGroupTool('lane', 'local-bot', 'owner-action')).rejects.toMatchObject({
        code: change.startsWith('temporary-') ? 'GROUP_AUTHORIZATION_UNAVAILABLE' : 'GROUP_AUTHORIZATION_REQUIRED' });
      if (change.startsWith('temporary-')) {
        changed = false;
        await expect(authorizeGroupTool('lane', 'local-bot', 'owner-action')).resolves.toBeDefined();
      }
    });

  it('keeps server plan steps in a grant-specific chat-only lane without opening a project', async () => {
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const planId = '70000000-0000-4000-8000-000000000001';
    const plan = { id: planId, revision: 1, source_message_id: execution.source_message_id, request_text: 'Discuss the draft',
      organizer_id: botId, creator_id: selfId, status: 'running', current_step: 0,
      steps: [{ position: 0, botId, botName: 'Bot', task: 'Discuss', status: 'running' }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    deps.workDir = { prepare: vi.fn(), snapshot: vi.fn(), changedFiles: vi.fn(), trashGroupFolder: vi.fn() };
    fixture.handle.mockImplementation(route => {
      if (route === '/executions/claim') { const next = claimed ? null : { ...execution, plan_id: planId, plan_step: 0 }; claimed = true; return { body: { execution: next } }; }
      if (route.includes('/plans')) return { body: [plan] };
      if (route.endsWith(`/messages/${execution.source_message_id}`)) return { body: { id: execution.source_message_id, seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: 'Discuss the draft' }], deleted: false, threadRootId: null } };
      return response(route);
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.ensureLane).toHaveBeenCalledWith(expect.objectContaining({ chatAccess: { mode: 'chat', revision: 1 }, plan: { planId, workDir: '', sessionId: undefined } }));
    expect(deps.workDir.prepare).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ toolsDisabled: true, message: expect.stringContaining('Discuss the draft') }));
  });
  it('projects hidden paused local companions with their real local identity and never claims work for them', async () => {
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', status: 'paused', hiddenAt: 1 }];
    fixture.handle.mockImplementation(route => route.endsWith('/snapshot') ? { body: { ...response(route).body,
      members: [{ id: botId, kind: 'bot', name: 'Bot', state: 'joined', role: 'member', ownerActorId: selfId, ownerName: 'Me' }] } } : response(route));
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.members[0]).toMatchObject({ botId: 'local-bot', status: 'paused', isOwned: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.handle.mock.calls.some(([route]) => route === '/executions/claim')).toBe(false);
  });
  it('returns text immediately while one attachment hangs or fails, then retries it independently', async () => {
    const mediaId = '60000000-0000-4000-8000-000000000001';
    const message = { id: execution.source_message_id, seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' },
      content: [{ type: 'text', text: 'Readable text' }, { type: 'media', mediaId, caption: 'report.pdf' }], createdAt: new Date().toISOString(), deleted: false, threadRootId: null };
    let reject!: (error: Error) => void;
    fixture.download.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    fixture.handle.mockImplementation(route => route.includes('/messages?') ? { body: [message] } : response(route));
    const result = await service.getGroup(roomId);
    expect(result.ok && result.group.messages[0].content).toContain('Readable text');
    reject(new Error('OBJECT_STORE_UNAVAILABLE')); await vi.advanceTimersByTimeAsync(0);
    expect((await service.getGroup(roomId)).ok).toBe(true);
    expect(fixture.download).toHaveBeenCalledOnce();
    fixture.download.mockResolvedValue({ id: mediaId, name: 'report.pdf', category: 'file', path: '/test/report.pdf', url: null });
    await vi.advanceTimersByTimeAsync(30000);
    await service.getGroup(roomId); await vi.advanceTimersByTimeAsync(0);
    const recovered = await service.getGroup(roomId);
    expect(recovered.ok && recovered.group.messages[0].attachments[0].name).toBe('report.pdf');
  });
  it('refreshes a reset room and resumes realtime from the authorized snapshot cursor', async () => {
    await service.getGroup(roomId);
    await vi.advanceTimersByTimeAsync(2000);
    const socket = fixture.sockets[0];
    Object.defineProperty(socket, 'readyState', { value: 1 });
    socket.emit('message', JSON.stringify({ type: 'ready' }));
    fixture.handle.mockImplementation(route => route.endsWith('/snapshot')
      ? { body: { ...response(route).body, cursor: '42' } } : response(route));
    vi.mocked(socket.send).mockClear();
    vi.mocked(deps.onChanged!).mockClear();
    socket.emit('message', JSON.stringify({ type: 'scope_error', scope: `conversation:${roomId}`, error: { code: 'RESET_REQUIRED' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', scope: `conversation:${roomId}`, after: '42' }));
    expect(deps.onChanged).toHaveBeenCalledWith(expect.objectContaining({ groupId: roomId }), undefined);
    vi.mocked(socket.send).mockClear();
    socket.emit('message', JSON.stringify({ type: 'changes', scope: `conversation:${roomId}`, cursor: '43', changes: [] }));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ack', scope: `conversation:${roomId}`, cursor: '43' }));
  });

  it.each(['before-commit', 'after-commit'])('retries an identical result after a lost response (%s) without rerunning the Agent', async loss => {
    const committed = new Map<string, unknown>();
    let attempts = 0;
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete') {
        attempts++;
        if (attempts === 1 && loss === 'before-commit') throw new Error('REQUEST_TIMEOUT');
        if (committed.has(body.operationId)) expect(body).toEqual(committed.get(body.operationId));
        committed.set(body.operationId, body);
        if (attempts === 1) throw new Error('ECONNRESET');
      }
      return response(route);
    });
    await start();
    expect(await service.settleLaneTurn(terminal)).toBe(true);
    expect(deliveries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(16000);
    expect(deliveries()).toHaveLength(2);
    expect(deliveries()[1][2]).toEqual(deliveries()[0][2]);
    expect(committed.size).toBe(1);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    expect(deliveries()).toHaveLength(2);
  });

  it('does not let an earlier heartbeat failure delete a pending terminal result', async () => {
    let rejectHeartbeat: (error: Error) => void = () => {};
    let heartbeatCount = 0, completes = 0;
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'heartbeat' && ++heartbeatCount === 3) return new Promise((_resolve, reject) => { rejectHeartbeat = reject; });
      if (body?.action === 'complete' && ++completes === 1) throw new Error('REQUEST_TIMEOUT');
      return response(route);
    });
    await start();
    await vi.advanceTimersByTimeAsync(13000);
    await service.settleLaneTurn(terminal);
    rejectHeartbeat(new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(16000);
    expect(deliveries()).toHaveLength(2);
    expect(deps.abortLane).not.toHaveBeenCalled();
  });

  it.each(['TOKEN_EXPIRED', 'INVALID_TOKEN', 'AUTH_REQUIRED'])('preserves an immutable completion during %s while Auth refresh fails or waits', async code => {
    let recovering = false;
    fixture.refresh.mockResolvedValue(false);
    fixture.handle.mockImplementation((route, _method, body) => body?.action === 'complete' && !recovering
      ? { status: 401, body: { error: { code } } } : response(route));
    await start();
    expect(await service.settleLaneTurn(terminal)).toBe(true);
    const payload = deliveries()[0][2];
    await vi.advanceTimersByTimeAsync(58_000);
    expect(deliveries()).toHaveLength(1);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    recovering = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveries()).toHaveLength(2);
    expect(deliveries()[1][2]).toEqual(payload);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliveries()).toHaveLength(2);
  });

  it('retains a completion when Auth rotates successfully but Chat still rejects the new token', async () => {
    let recovering = false;
    fixture.refresh.mockImplementation(async () => { fixture.token = 'renewed-test-token'; return true; });
    fixture.handle.mockImplementation((route, _method, body) => body?.action === 'complete' && !recovering
      ? { status: 401, body: { error: { code: 'INVALID_TOKEN' } } } : response(route));
    await start();
    await service.settleLaneTurn(terminal);
    expect(deliveries()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(deliveries()).toHaveLength(2);
    recovering = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveries()).toHaveLength(3);
    expect(deliveries().every(([, , body]) => JSON.stringify(body) === JSON.stringify(deliveries()[0][2]))).toBe(true);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('keeps the lease alive while a prepared completion waits for authentication recovery', async () => {
    let recovering = false;
    let leaseUntil = Date.now() + 60_000;
    let committed = 0;
    fixture.refresh.mockResolvedValue(false);
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete' && !recovering) return { status: 401, body: { error: { code: 'INVALID_TOKEN' } } };
      if (body?.action === 'heartbeat' || body?.action === 'complete') {
        if (Date.now() >= leaseUntil) return { status: 409, body: { error: { code: 'STALE_EXECUTOR' } } };
        leaseUntil = Date.now() + 60_000;
        if (body.action === 'complete') committed += 1;
      }
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(deliveries()).toHaveLength(1);
    recovering = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(committed).toBe(1);
    expect(deliveries()[1][2]).toEqual(deliveries()[0][2]);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, code: 'ACCOUNT_UNAVAILABLE' },
    { status: 403, code: 'ROLE_REQUIRED' },
    { status: 404, code: 'EXECUTION_NOT_FOUND' },
    { status: 409, code: 'STALE_EXECUTOR' },
    { status: 410, code: 'EXECUTION_EXPIRED' },
  ])('releases an auth-delayed completion immediately after a definitive heartbeat $code', async ({ status, code }) => {
    let rejectHeartbeat = false;
    let replacementQueued = false;
    const nextExecution = { ...execution, id: '40000000-0000-4000-8000-000000000002', epoch: 2 };
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete') return { status: 429, headers: { 'retry-after': '3600' }, body: { error: { code: 'RATE_LIMITED' } } };
      if (body?.action === 'heartbeat' && rejectHeartbeat) {
        rejectHeartbeat = false;
        return { status, body: { error: { code } } };
      }
      if (route === '/executions/claim' && replacementQueued) {
        replacementQueued = false;
        return { body: { execution: nextExecution } };
      }
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    rejectHeartbeat = true;
    replacementQueued = true;
    await vi.advanceTimersByTimeAsync(18_000);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.dispatch).mock.calls[1][0].clientId).toContain(nextExecution.id);
    expect(deliveries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(deliveries()).toHaveLength(1);
  });

  it.each([401, 503])('retains the completed reply when the waiting heartbeat has a temporary %s response', async status => {
    let recovering = false;
    fixture.refresh.mockResolvedValue(false);
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete' && !recovering) return { status: 401, body: { error: { code: 'INVALID_TOKEN' } } };
      if (body?.action === 'heartbeat' && !recovering && Date.now() > new Date('2026-10-03T00:00:02Z').getTime())
        return { status, body: { error: { code: status === 401 ? 'INVALID_TOKEN' : 'SERVICE_UNAVAILABLE' } } };
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    await vi.advanceTimersByTimeAsync(58_000);
    recovering = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveries()).toHaveLength(2);
    expect(deliveries()[1][2]).toEqual(deliveries()[0][2]);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('keeps the original completion receipt lookup after a lost committed response', async () => {
    let committed: unknown;
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'heartbeat' && committed) return { status: 409, body: { error: { code: 'STALE_EXECUTOR' } } };
      if (body?.action === 'complete') {
        if (!committed) { committed = body; throw new Error('ECONNRESET'); }
        expect(body).toEqual(committed);
      }
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(deliveries()).toHaveLength(2);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it.each([401, 429])('preserves a pending completion after an HTML %s and observes the delivery wait', async status => {
    let recovering = false;
    fixture.handle.mockImplementation((route, _method, body) => body?.action === 'complete' && !recovering
      ? { status, headers: { 'retry-after': '120' }, rawBody: '<html>temporary upstream fixture</html>' } : response(route));
    await start();
    await service.settleLaneTurn(terminal);
    const wait = status === 429 ? 120_000 : 60_000;
    await vi.advanceTimersByTimeAsync(wait - 2_000);
    expect(deliveries()).toHaveLength(1);
    recovering = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveries()).toHaveLength(2);
    expect(deliveries()[1][2]).toEqual(deliveries()[0][2]);
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it.each([{ status: 401, code: 'ACCOUNT_UNAVAILABLE' }, { status: 403, code: 'ROLE_REQUIRED' }, { status: 409, code: 'STALE_EXECUTOR' }])('stops a completion after a definitive rejection $code', async ({ status, code }) => {
    fixture.handle.mockImplementation((route, _method, body) => body?.action === 'complete'
      ? { status, body: { error: { code } } } : response(route));
    await start();
    await service.settleLaneTurn(terminal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliveries()).toHaveLength(1);
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('does not retry a previous owner’s auth-delayed completion', async () => {
    service.dispose();
    let epoch = 0;
    deps.captureOwnerScope = () => ({ epoch }) as ReturnType<NonNullable<BotGroupChatServiceDeps['captureOwnerScope']>>;
    deps.isOwnerScopeCurrent = captured => (captured as unknown as { epoch: number }).epoch === epoch;
    service = withChatServer({ dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    fixture.refresh.mockResolvedValue(false);
    fixture.handle.mockImplementation((route, _method, body) => body?.action === 'complete'
      ? { status: 401, body: { error: { code: 'INVALID_TOKEN' } } } : response(route));
    await start();
    await service.settleLaneTurn(terminal);
    epoch += 1;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliveries()).toHaveLength(1);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('uses a fresh operation id for each lease renewal', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(30000);
    const ids = fixture.handle.mock.calls.filter(([, , body]) => body?.action === 'heartbeat').map(([, , body]) => body.operationId);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops retries when the server rejects a revoked or expired execution', async () => {
    let attempts = 0;
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete') {
        if (++attempts === 1) throw new Error('ECONNRESET');
        return { status: 409, body: { error: { code: 'STALE_EXECUTOR' } } };
      }
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    await vi.advanceTimersByTimeAsync(46000);
    expect(deliveries()).toHaveLength(2);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('does not retry a previous owner’s pending result after disposal', async () => {
    fixture.handle.mockImplementation((route, _method, body) => {
      if (body?.action === 'complete') throw new Error('ECONNRESET');
      return response(route);
    });
    await start();
    await service.settleLaneTurn(terminal);
    service.dispose();
    await vi.advanceTimersByTimeAsync(46000);
    expect(deliveries()).toHaveLength(1);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it('refreshes subscribed groups immediately even without a connected WebSocket', async () => {
    expect((await service.getGroup(roomId)).ok).toBe(true);
    vi.mocked(deps.onChanged!).mockClear();
    expect(await service.chatServer!.refreshProfile()).toMatchObject({ ok: true });
    expect(deps.onChanged).toHaveBeenCalledWith({ groupId: roomId, change: 'messages' }, undefined);
    expect(deps.onChanged).toHaveBeenCalledWith({ groupId: '', change: 'messages' }, undefined);
  });

  it('reads subsequent group pages even when the first page contains only invitations', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ ...room(`60000000-0000-4000-8000-${String(i).padStart(12, '0')}`), state: 'invited' }));
    fixture.handle.mockImplementation(route => {
      if (route === '/conversations?limit=100') return { body: firstPage };
      if (route === `/conversations?limit=100&after=${firstPage[99].id}`) return { body: [room(roomId)] };
      return response(route);
    });
    const result = await service.listGroups();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.groups.map(g => g.id)).toEqual([roomId]);
    expect(fixture.handle).toHaveBeenCalledWith(`/conversations?limit=100&after=${firstPage[99].id}`, 'GET', undefined);
    expect(fixture.handle.mock.calls.some(([route]) => route.includes('/messages?'))).toBe(false);
  });
});

describe('Chat authentication recovery and polling backoff', () => {
  let service: BotGroupChatService;
  const denied = (code = 'INVALID_TOKEN') => ({ status: 401, body: { error: { code } } });
  const healthy = (route: string) => ({ body: route === '/me' ? { actor: { id: 'self' } } : [] });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    fixture.packaged = true;
    fixture.profiles = [];
    fixture.requests = [];
    fixture.token = 'isolated-test-token';
    fixture.refresh.mockReset().mockResolvedValue(true);
    fixture.handle.mockReset().mockImplementation(healthy);
    service = withChatServer({ dispose: vi.fn(), listGroups: async () => ({ ok: true, groups: [] }) } as unknown as BotGroupChatService, {} as BotGroupChatServiceDeps);
  });

  afterEach(() => {
    service.dispose();
    fixture.token = 'isolated-test-token';
    fixture.refresh.mockReset().mockResolvedValue(true);
    vi.useRealTimers();
  });

  it.each(['TOKEN_EXPIRED', 'INVALID_TOKEN', 'AUTH_REQUIRED'])('refreshes %s once and replays with the current token', async code => {
    fixture.handle.mockImplementation(route => fixture.token === 'isolated-test-token' ? denied(code) : healthy(route));
    fixture.refresh.mockImplementation(async () => { fixture.token = 'renewed-test-token'; return true; });
    expect(await service.chatServer!.refreshProfile()).toMatchObject({ ok: true });
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.requests.map(r => r.token)).toEqual(['Bearer isolated-test-token', 'Bearer renewed-test-token']);
  });

  it.each([true, false])('bounds repeated foreground 401s when Auth refresh returns %s', async refreshed => {
    fixture.handle.mockImplementation(() => denied());
    let rotation = 0;
    fixture.refresh.mockImplementation(async () => {
      if (refreshed) fixture.token = `renewed-test-token-${++rotation}`;
      return refreshed;
    });
    for (let i = 0; i < 10; i += 1) {
      expect(await service.chatServer!.refreshProfile()).toMatchObject({ ok: false });
    }
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.requests).toHaveLength(refreshed ? 11 : 10);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await service.chatServer!.refreshProfile();
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh across concurrent 401 responses', async () => {
    let finish!: (value: boolean) => void;
    fixture.refresh.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    fixture.handle.mockImplementation(route => fixture.token === 'isolated-test-token' ? denied('TOKEN_EXPIRED') : healthy(route));
    const first = service.chatServer!.refreshProfile();
    const second = service.chatServer!.refreshProfile();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    fixture.token = 'renewed-test-token';
    finish(true);
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it('reuses a newer token for a late 401 without rotating again', async () => {
    let finish!: (value: ReturnType<typeof denied>) => void;
    fixture.handle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fixture.handle.mockImplementation(route => fixture.token === 'isolated-test-token' ? denied() : healthy(route));
    fixture.refresh.mockImplementation(async () => { fixture.token = 'renewed-test-token'; return true; });
    const first = service.chatServer!.refreshProfile();
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.chatServer!.refreshProfile()).toMatchObject({ ok: true });
    finish(denied());
    expect(await first).toMatchObject({ ok: true });
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it.each(['ACCOUNT_UNAVAILABLE', 'SOME_OTHER_CODE', undefined])('does not refresh on a non-recoverable 401 code %s', async code => {
    fixture.handle.mockImplementation(() => ({ status: 401, body: { error: { code } } }));
    expect(await service.chatServer!.refreshProfile()).toMatchObject({ ok: false });
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it('pauses the two-second poll after persistent 401 and resumes after the wait', async () => {
    fixture.handle.mockImplementation(() => denied());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(fixture.requests).toHaveLength(2);
    fixture.handle.mockImplementation(healthy);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.requests.some(r => new URL(r.url).pathname === '/v1/actors')).toBe(true);
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it.each([false, true])('honors a longer Retry-After on 429 (HTML=%s) without calling Auth refresh', async html => {
    fixture.handle.mockImplementation(() => ({ status: 429, headers: { 'retry-after': '120' }, body: { error: { code: 'RATE_LIMITED' } }, ...(html ? { rawBody: '<html>rate limit fixture</html>' } : {}) }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(118_000);
    expect(fixture.requests).toHaveLength(1);
    fixture.handle.mockImplementation(healthy);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.requests.some(r => new URL(r.url).pathname === '/v1/actors')).toBe(true);
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it('backs off temporary server errors and returns to normal polling on recovery', async () => {
    fixture.handle.mockImplementation(() => ({ status: 503, body: { error: { code: 'JWKS_UNAVAILABLE' } } }));
    await vi.advanceTimersByTimeAsync(18_000);
    expect(fixture.requests).toHaveLength(4); // Requests at 2s, 4s, 8s and 16s.
    fixture.handle.mockImplementation(healthy);
    await vi.advanceTimersByTimeAsync(14_000);
    const meCalls = () => fixture.requests.filter(r => new URL(r.url).pathname === '/v1/me').length;
    expect(meCalls()).toBe(5);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(meCalls()).toBe(6);
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it('does not refresh on an HTML challenge or leak its body through the error result', async () => {
    fixture.handle.mockImplementation(() => ({ status: 401, rawBody: '<script>private-challenge-fixture</script>' }));
    const result = await service.chatServer!.refreshProfile();
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_CHAT_RESPONSE' });
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-challenge-fixture');
  });

  it('discards a late refresh after owner change and gives the new owner an independent recovery window', async () => {
    service.dispose();
    let epoch = 0;
    const deps = {
      captureOwnerScope: () => ({ epoch }),
      isOwnerScopeCurrent: (scope: { epoch: number }) => scope.epoch === epoch,
    } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    fixture.handle.mockImplementation(() => denied());
    let finish!: (value: boolean) => void;
    fixture.refresh.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const oldRequest = service.chatServer!.refreshProfile();
    await vi.advanceTimersByTimeAsync(0);
    epoch += 1;
    fixture.token = 'new-owner-test-token';
    finish(true);
    expect(await oldRequest).toMatchObject({ ok: false });
    expect(fixture.requests).toHaveLength(1);
    fixture.refresh.mockResolvedValue(true);
    await service.chatServer!.refreshProfile();
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
    expect(fixture.requests.slice(1).every(r => r.token === 'Bearer new-owner-test-token')).toBe(true);
  });
});
