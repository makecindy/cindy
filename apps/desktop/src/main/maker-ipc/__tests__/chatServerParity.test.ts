import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ upload: vi.fn(async () => []), download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: fixture.upload, download: fixture.download }) }));
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
import { buildBotGroupThreadShareCard } from '../../../shared/botGroupChat.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('server group feature parity', () => {
  const roomId = '10000000-0000-4000-8000-000000000001';
  const botId = '20000000-0000-4000-8000-000000000001';
  const selfId = '30000000-0000-4000-8000-000000000001';
  const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: roomId,
    source_message_id: '50000000-0000-4000-8000-000000000001', bot_id: botId,
    context_seq: '100', epoch: 1, status: 'running', access_mode: 'chat', access_revision: 1 };
  const room = (id: string) => ({ id, kind: 'group', name: 'Room', state: 'joined', response_mode: 'all', speaking_mode: 'auto',
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
    if (route.includes('/messages?') || route.endsWith('/executions') || route.includes('/execution-failures?') || route.includes('/plans')) return { body: [] };
    return { body: {} };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    fixture.packaged = false; fixture.exists.mockReturnValue(true); fixture.profiles = []; fixture.sockets = []; claimed = false;
    fixture.config = '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}';
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.handle.mockImplementation(response);
    deps = { ensureLane: vi.fn(async () => ({ ok: true, sessionId: 'lane' })), abortLane: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: Parameters<BotGroupChatServiceDeps['dispatch']>[0]) => { await input.onAccepted?.(); return { ok: true }; }),
      onChanged: vi.fn(),
    } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
  });
  // Unit regression: remote executions have no local lane but must keep their
  // exact identity and waiting/stopping state; concurrent turns cannot be deduped.
  it('retains remote waiting and stopping executions in the group projection', async () => {
    fixture.handle.mockImplementation((route: string) => route.endsWith('/executions') ? { body: [
      { ...execution, status: 'needs_input' },
      { ...execution, id: '40000000-0000-4000-8000-000000000002', status: 'stopping' },
    ] } : response(route));
    const result = await service.getGroup(roomId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.round.speakers.map(speaker => [speaker.executionId, speaker.executionStatus, speaker.sessionId])).toEqual([
      [execution.id, 'needs_input', null], ['40000000-0000-4000-8000-000000000002', 'stopping', null],
    ]);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); fixture.config = ''; vi.clearAllMocks(); });
  const secondBotId = '20000000-0000-4000-8000-000000000002';
  const planId = '70000000-0000-4000-8000-000000000001';
  const members = [botId, secondBotId].map(id => ({ id, kind: 'bot', name: id === botId ? 'Bot' : 'Peer',
    state: 'joined', role: 'member', ownerActorId: selfId, ownerName: 'Me', guestAccess: 'chat' }));
  const steps = members.map((m, position) => ({ position, botId: m.id, botName: m.name, task: 'Make a draft', status: 'pending' }));
  const proposed = { id: planId, revision: 1, source_message_id: execution.source_message_id, request_text: 'Make a draft',
    organizer_id: botId, creator_id: selfId, status: 'proposed', current_step: null, steps,
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' };
  const send = (overrides = {}) => service.sendMessage({ groupId: roomId, text: 'Make a draft', clientId: 'parity:message:1',
    mentions: { all: false, botIds: [] }, ...overrides });
  const planPosts = () => fixture.handle.mock.calls.filter(([route, method]) => route === `/conversations/${roomId}/plans` && method === 'POST');
  function arrange(plan?: typeof proposed, roomMembers = members) {
    deps.decidePlan = vi.fn(async () => ({ needsPlan: true, steps: steps.map(({ botId, task }) => ({ botId, task })) }));
    fixture.handle.mockImplementation((route, method) => {
      if (route.endsWith('/snapshot')) return { body: { room: room(roomId), members: roomMembers, messages: [], cursor: '1' } };
      if (route.endsWith('/members')) return { body: roomMembers };
      if (route.includes('/plans') && method === 'GET') return { body: plan ? [plan] : [] };
      if (route.endsWith('/messages') && method === 'POST') return { body: { id: execution.source_message_id } };
      return response(route);
    });
  }
  async function flush() { await vi.advanceTimersByTimeAsync(0); }
  // Mention-only must suppress the auxiliary planning request as well as model replies.
  it.each([undefined, 'proposed', 'waiting'] as const)('keeps unaddressed mention-only messages idle with plan=%s', async status => {
    arrange(status ? { ...proposed, status } : undefined);
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => route.endsWith('/snapshot')
      ? { body: { room: { ...room(roomId), response_mode: 'mentioned' }, members, messages: [], cursor: '1' } }
      : base(route, method, data));
    expect((await send()).ok).toBe(true); await flush();
    expect(deps.decidePlan).not.toHaveBeenCalled();
    expect(planPosts()).toHaveLength(0);
    expect(fixture.handle.mock.calls.some(([route, method]) => route.includes(`/plans/${planId}`) && method === 'POST')).toBe(false);
    const posted = fixture.handle.mock.calls.find(([route, method]) => route.endsWith('/messages') && method === 'POST')![2];
    expect(posted).toMatchObject({ deferExecution: false, mentions: [] });
  });
  it.each([{ division: true }, { mentions: { all: true, botIds: [] } }])('keeps directed planning available in mention-only rooms: %j', async input => {
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => route.endsWith('/snapshot')
      ? { body: { room: { ...room(roomId), response_mode: 'mentioned' }, members, messages: [], cursor: '1' } }
      : base(route, method, data));
    expect((await send(input)).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledTimes(1);
    expect(planPosts()).toHaveLength(1);
  });
  it.each([
    ['proposed', 'dismiss'],
    ['waiting', 'stop'],
  ])('dismisses a %s plan using the server %s action', async (status, expectedAction) => {
    arrange({ ...proposed, status });
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => {
      if (route === `/conversations/${roomId}/plans/${planId}` && method === 'POST') {
        const accepted = status === 'waiting' ? data.action === 'stop' : data.action === 'dismiss';
        return accepted ? { body: {} } : { status: 409, body: { error: { code: 'PLAN_CLOSED' } } };
      }
      return base(route, method, data);
    });
    expect(await service.dismissPlan({ groupId: roomId, planId })).toEqual({ ok: true });
    expect(fixture.handle.mock.calls.find(([route, method]) => route === `/conversations/${roomId}/plans/${planId}` && method === 'POST')?.[2])
      .toMatchObject({ action: expectedAction, expectedRevision: 1 });
  });
  it.each([
    ['ordinary request', {}, undefined],
    ['@all', { mentions: { all: true, botIds: [] } }, undefined],
  ])('asks the organizer for %s without changing server mentions', async (_name, input, roster) => {
    arrange(undefined, roster);
    expect((await send(input)).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }), expect.any(AbortSignal));
    expect(planPosts()).toHaveLength(1);
    const posted = fixture.handle.mock.calls.find(([route, method]) => route.endsWith('/messages') && method === 'POST')![2];
    expect(posted.deferExecution).toBe(true);
    expect(posted.mentions).toEqual(_name === '@all' ? [botId, secondBotId] : []);
  });
  it('gives an explicit 安排分工 the 引用回复 it quotes, in the decision and the stored request', async () => {
    const quotedId = '80000000-0000-4000-8000-000000000001';
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => route === `/conversations/${roomId}/messages/${quotedId}`
      ? { body: { id: quotedId, seq: '7', authorId: secondBotId, author: { kind: 'bot', name: 'Peer' }, origin: 'bot', deleted: false,
        threadRootId: null, createdAt: '2026-10-03T00:00:00Z', content: [{ type: 'text', text: 'Landing page: hero, pricing, FAQ' },
          { type: 'media', mediaId: '80000000-0000-4000-8000-0000000000f1', caption: 'wireframe.png' }] } }
      : base(route, method, data));
    expect((await send({ text: 'Do this one', division: true, quote: { messageId: quotedId } })).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'forced', request: 'Do this one',
      requestQuote: { from: 'Peer (Me)', text: 'Landing page: hero, pricing, FAQ', attachments: 1, attachmentName: 'wireframe.png' } }), expect.any(AbortSignal));
    expect(planPosts()[0]?.[2]).toMatchObject({ request: 'Do this one\n\n> Peer (Me): Landing page: hero, pricing, FAQ 📎 wireframe.png' });
  });

  it('tells the organizer which recent message re-posts a thread reply', async () => {
    const replyId = '80000000-0000-4000-8000-000000000002';
    const card = buildBotGroupThreadShareCard({ messageId: replyId, threadRootId: '80000000-0000-4000-8000-000000000003', authorName: 'Peer', text: '@Peer 马上开工' });
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => route.endsWith('/snapshot')
      ? { body: { room: room(roomId), members, cursor: '1', messages: [{ id: '80000000-0000-4000-8000-000000000004', seq: '3', authorId: 'someone',
        author: { kind: 'human', name: 'Alice' }, origin: 'human', deleted: false, threadRootId: null, createdAt: '2026-10-03T00:00:00Z', content: [card] }] } }
      : base(route, method, data));
    expect((await send({ text: 'Do this one', division: true })).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({
      recent: [expect.objectContaining({ from: 'Alice', sharedReplyId: replyId })] }), expect.any(AbortSignal));
  });

  it('returns one available member to ordinary discussion using the real decision parser', async () => {
    arrange(undefined, members.slice(0, 1));
    const { parsePlanDecision } = await import('../botGroupDivision.js');
    deps.decidePlan = vi.fn<NonNullable<BotGroupChatServiceDeps['decidePlan']>>(async input => parsePlanDecision(JSON.stringify({ needsPlan: true, steps: [{ botId, task: 'Make a draft' }] }), input.mode, new Set(input.members.map(m => m.botId))));
    expect((await send()).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }), expect.any(AbortSignal));
    expect(planPosts()).toHaveLength(0);
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/continue'))).toBe(true);
  });
  it.each(['prepare', 'upload', 'submit'])('preserves the pending decision when a later send fails at %s', async stage => {
    arrange();
    let finish!: (value: { needsPlan: true; steps: typeof steps }) => void;
    const decide = vi.fn<NonNullable<BotGroupChatServiceDeps['decidePlan']>>(() => new Promise(resolve => { finish = resolve; }));
    deps.decidePlan = decide;
    await send(); await flush();
    const signal = decide.mock.calls[0]![1];
    deps.prepareAttachments = vi.fn(async () => stage === 'prepare'
      ? { ok: false as const, errorCode: 'INVALID_PARAMS' as const, message: 'invalid' }
      : { ok: true as const, attachments: [], commit: vi.fn(), discard: vi.fn(async () => {}) });
    if (stage === 'upload') fixture.upload.mockRejectedValueOnce(new Error('MEDIA_UPLOAD_FAILED'));
    if (stage === 'submit') {
      const base = fixture.handle.getMockImplementation()!;
      fixture.handle.mockImplementation((route, method, data) => route.endsWith('/messages') && method === 'POST'
        ? { status: 500, body: { error: { code: 'INTERNAL' } } } : base(route, method, data));
    }
    expect((await send({ clientId: `failed-${stage}`, attachments: [{}] })).ok).toBe(false);
    expect(signal.aborted).toBe(false);
    finish({ needsPlan: true, steps }); await flush();
    expect(planPosts()).toHaveLength(1);
  });
  it.each([false, true])('revises a proposed plan, including forced=%s, without losing its steps', async division => {
    arrange(proposed);
    expect((await send({ division })).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'revise', currentSteps: steps }), expect.any(AbortSignal));
    expect(planPosts()).toHaveLength(1);
  });
  it('does not replace another person’s proposed plan or auto-plan around an active plan', async () => {
    for (const plan of [{ ...proposed, creator_id: 'someone-else' }, { ...proposed, status: 'running' }]) {
      arrange(plan);
      expect((await send()).ok).toBe(true); await flush();
      expect(deps.decidePlan).not.toHaveBeenCalled();
      expect((await send({ division: true })).ok).toBe(false);
    }
    expect(planPosts()).toHaveLength(0);
  });
  it.each(['mention', 'stop', 'dismiss', 'start', 'edit'])('invalidates a pending decision on %s', async action => {
    arrange(proposed);
    let finish!: (value: { needsPlan: true; steps: typeof steps }) => void;
    const decide = vi.fn<NonNullable<BotGroupChatServiceDeps['decidePlan']>>(() => new Promise(resolve => { finish = resolve; }));
    deps.decidePlan = decide;
    await send(); await flush();
    const signal = decide.mock.calls[0]![1];
    if (action === 'mention') await send({ clientId: 'parity:message:2', mentions: { all: false, botIds: [botId] } });
    else if (action === 'stop') await service.stopRound(roomId);
    else if (action === 'dismiss') await service.dismissPlan({ groupId: roomId, planId });
    else if (action === 'start') await service.startPlan({ groupId: roomId, planId });
    else await service.editPlanStep({ groupId: roomId, planId, position: 0, action: 'reassign', botId });
    expect(signal.aborted).toBe(true);
    finish({ needsPlan: true, steps }); await flush();
    expect(planPosts()).toHaveLength(0);
    const view = await service.getGroup(roomId);
    expect(view).toMatchObject({ ok: true, group: { planningBotId: null } });
  });
  it('keeps @all on an existing proposal as discussion, not a revision', async () => {
    arrange(proposed);
    await send({ mentions: { all: true, botIds: [] } }); await flush();
    expect(deps.decidePlan).not.toHaveBeenCalled();
    expect(planPosts()).toHaveLength(0);
  });
  it('does not resurrect planning when a cancelled send gets a late upload receipt', async () => {
    arrange();
    let finishUpload!: () => void;
    fixture.upload.mockImplementationOnce(() => new Promise(resolve => { finishUpload = () => resolve([]); }));
    const first = send(); await flush();
    await service.stopRound(roomId);
    finishUpload(); expect((await first).ok).toBe(true); await flush();
    expect(deps.decidePlan).not.toHaveBeenCalled();
    expect(planPosts()).toHaveLength(0);
  });
  it('delivers up to forty ordinary discussion attachments and preserves the silent reply option', async () => {
    arrange();
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const messages = Array.from({ length: 45 }, (_, n) => ({ id: `message-${n}`, seq: String(n + 1), authorId: selfId,
      author: { kind: 'human', name: 'Me' }, deleted: false, threadRootId: null,
      content: [{ type: 'media', mediaId: `60000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, caption: `file-${n}` }] })).reverse();
    fixture.download.mockImplementation(async (_room, id) => ({ id, name: id, category: 'file', path: '/test/file', url: null }));
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.includes('/messages?') ? { body: messages } : base(route, ...args));
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    const input = vi.mocked(deps.dispatch).mock.calls[0][0];
    expect(input.attachments).toHaveLength(40);
    expect(input.message).toContain('NO_REPLY');
    expect(input.message).toContain('attachment limit');
    expect(input.message).toContain('file-0');
    expect(input.attachments![0].id).toBe(messages[0].content[0].mediaId);
  });
  // Runtime regression: stopping a running group reply used to forget the lane
  // without acknowledging cancel, leaving every device spinning until lease expiry.
  it.each(['local', 'remote', 'retry'] as const)('acknowledges %s stop without publishing a reply or losing the task during retry', async origin => {
    arrange();
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    let state = 'running';
    let cancels = 0;
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, method, data) => {
      if (route.endsWith('/executions')) return { body: [{ ...execution, status: state }] };
      if (route.endsWith('/control')) { state = 'stopping'; return { body: {} }; }
      if (route.endsWith(`/executions/${execution.id}`)) {
        if (data.action === 'heartbeat' && state === 'stopping') return { status: 409, body: { error: { code: 'STOP_REQUESTED' } } };
        if (data.action === 'cancel') {
          cancels++;
          if (origin === 'retry' && cancels === 1) return { status: 503, body: { error: { code: 'UNAVAILABLE' } } };
          state = 'cancelled';
        }
      }
      return base(route, method, data);
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    if (origin === 'remote') {
      state = 'stopping';
      await vi.advanceTimersByTimeAsync(13000);
    } else await service.stopRound(roomId);
    if (origin === 'retry') {
      expect(await service.getGroup(roomId)).toMatchObject({ group: { round: { speakers: [{ sessionId: 'lane', executionStatus: 'stopping' }] } } });
      await vi.advanceTimersByTimeAsync(16000);
    }
    expect(state).toBe('cancelled');
    expect(deps.abortLane).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledOnce();
    const writes = fixture.handle.mock.calls.filter(([route, method]) => route.endsWith(`/executions/${execution.id}`) && method === 'POST');
    expect(writes.some(([, , data]) => data.action === 'complete')).toBe(false);
    expect(writes.filter(([, , data]) => data.action === 'cancel').every(([, , data]) => !data.content)).toBe(true);
    expect(await service.getGroup(roomId)).toMatchObject({ group: { round: { status: 'idle', speakers: [] } } });
  });
  it('negotiates broadcast and cancels the server deferred source on stop', async () => {
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route === '/me' ? { body: { actor: { id: selfId }, capabilities: { groupDiscussionParity: 1 } } } : base(route, ...args));
    let finish!: (value: unknown) => void;
    deps.decidePlan = vi.fn(() => new Promise(resolve => { finish = resolve; })) as typeof deps.decidePlan;
    await send({ mentions: { all: true, botIds: [] } }); await flush();
    expect(fixture.handle.mock.calls.find(([route, method]) => route.endsWith('/messages') && method === 'POST')?.[2].mentionsAll).toBe(true);
    await service.stopRound(roomId);
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/cancel-planning'))).toBe(true);
    finish({ needsPlan: true, steps }); await flush();expect(planPosts()).toHaveLength(0);
  });
  it('reports forced planning failure without silently starting ordinary discussion', async () => {
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route === '/me' ? { body: { actor: { id: selfId }, capabilities: { groupDiscussionParity: 1 } } } : base(route, ...args));
    deps.decidePlan = vi.fn(async () => null);
    await send({ division: true });await flush();
    expect(fixture.handle.mock.calls.find(([route]) => route.endsWith('/cancel-planning'))?.[2].failed).toBe(true);
    expect(fixture.handle.mock.calls.some(([route]) => route.endsWith('/continue'))).toBe(false);
  });
  // The send is answered once its message is stored; replacing the earlier arrangement continues
  // afterwards. Formerly a failed cancel of that arrangement failed the whole (already stored) send
  // and relied on the user retrying it with the same quote snapshot.
  it('answers a stored quote reply at once and retries a failed cancel of the replaced arrangement', async () => {
    const quotedId = '80000000-0000-4000-8000-000000000002';
    arrange();
    const base = fixture.handle.getMockImplementation()!;
    let originalVisible = true;
    let cancelFails = true;
    fixture.handle.mockImplementation((route, method, data) => {
      if (route === '/me') return { body: { actor: { id: selfId }, capabilities: { groupDiscussionParity: 1 } } };
      if (route === `/conversations/${roomId}/messages/${quotedId}`) return originalVisible
        ? { body: { id: quotedId, seq: '7', authorId: secondBotId, author: { kind: 'bot', name: 'Peer' }, origin: 'bot', deleted: false,
          threadRootId: null, createdAt: '2026-10-03T00:00:00Z', content: [{ type: 'text', text: 'Hero, pricing, FAQ' }] } }
        : { status: 404, body: { error: { code: 'MESSAGE_NOT_FOUND' } } };
      // The server stores each operation once and answers a repeat with the same message.
      if (route.endsWith('/messages') && method === 'POST') return { body: { id: `stored:${data.operationId}` } };
      if (route.endsWith('/cancel-planning') && cancelFails) { cancelFails = false; return { status: 500, body: { error: { code: 'UPSTREAM_FAILED' } } }; }
      return base(route, method, data);
    });
    deps.decidePlan = vi.fn(() => new Promise(() => {})) as typeof deps.decidePlan;
    // A: an ordinary request whose arrangement is still being decided.
    expect((await send({ clientId: 'parity:message:a' })).ok).toBe(true); await flush();
    // B: stored by the server; the bookkeeping that replaces A's intent fails once, after the answer.
    const quoteReply = { clientId: 'parity:message:b', text: 'Do this one', quote: { messageId: quotedId } };
    expect(await send(quoteReply)).toEqual({ ok: true, messageId: 'stored:parity:message:b' });
    await flush();
    const cancels = fixture.handle.mock.calls.filter(([route]) => route === `/conversations/${roomId}/messages/stored:parity:message:a/cancel-planning`);
    expect(cancels).toHaveLength(2);
    expect(cancels[1]![2]).toEqual(cancels[0]![2]);
    // A repeat of the answered send returns its receipt without posting or reading the quote again.
    originalVisible = false;
    expect(await send(quoteReply)).toEqual({ ok: true, messageId: 'stored:parity:message:b' });
    const posts = fixture.handle.mock.calls.filter(([route, method, data]) => route.endsWith('/messages') && method === 'POST' && data.operationId === 'parity:message:b');
    expect(posts).toHaveLength(1);
    expect(posts[0]![2].content[0]).toMatchObject({ namespace: 'cindy.quote' });
    expect(fixture.handle.mock.calls.filter(([route]) => route === `/conversations/${roomId}/messages/${quotedId}`)).toHaveLength(1);
  });
  it('keeps legacy servers without a watermark on the bounded text page', async () => {
    arrange();fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.includes('/messages?') ? { body: Array.from({ length: 100 }, (_, n) => ({
      id: `message-${n}`, seq: String(100-n), authorId: selfId, author: { kind: 'human', name: 'Me' }, deleted: false, content: [{ type: 'text', text: 'history' }],
    })) } : base(route, ...args));
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(fixture.handle.mock.calls.filter(([route]) => route.includes('/messages?'))).toHaveLength(1);
  });
  it('paginates unseen attachments before the text window and skips delivered files', async () => {
    arrange();fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const base = fixture.handle.getMockImplementation()!;
    const message = (seq: number, media = false) => ({ id: `message-${seq}`, seq: String(seq), authorId: selfId, author: { kind: 'human', name: 'Me' }, deleted: false,
      content: media ? [{ type: 'media', mediaId: `60000000-0000-4000-8000-${String(seq).padStart(12,'0')}` }] : [{ type: 'text', text: 'text' }] });
    fixture.handle.mockImplementation((route, ...args) => {
      if (route === '/executions/claim' && !claimed) { claimed = true; return { body: { execution: { ...execution, context_seq: '350', attachment_after_seq: '100' } } }; }
      if (route.includes('/messages?')) {
        if (route.endsWith('before=351')) return { body: Array.from({ length: 100 }, (_, n) => message(350-n)) };
        if (route.endsWith('before=251')) return { body: Array.from({ length: 100 }, (_, n) => message(250-n,n===99)) };
        return { body: [message(150,true),message(100,true)] };
      }
      return base(route, ...args);
    });
    fixture.download.mockImplementation(async (_room, id) => ({ id, name: id, category: 'file', path: '/test/file', url: null }));
    await vi.advanceTimersByTimeAsync(2000);
    const input = vi.mocked(deps.dispatch).mock.calls[0][0];
    expect(input.attachments?.map(a => a.id)).toEqual([151,150].map(n => `60000000-0000-4000-8000-${String(n).padStart(12,'0')}`));
    expect(fixture.urls.some(url => url.endsWith('before=151'))).toBe(true);
  });

});
