import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: vi.fn() }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: () => '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), { limit: async () => [{ id: 'existing-local-group' }] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string; headers: Record<string, string> }, callback: (response: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        const target = new URL(url);
        void Promise.resolve().then(() => fixture.handle(target.pathname.slice(3) + target.search, options.method,
          data ? JSON.parse(data) : undefined, options.headers['X-Chat-Actor']))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200, headers: {} });
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
    constructor() { super(); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import { createCompanionHomeRegistry } from '../../companion-cloud/homes.js';
import { createCompanionCloudState } from '../../companion-cloud/state.js';
import { activeCompanionCloud, type CompanionCloudHost } from '../../companion-cloud/runtime.js';
import * as chatRoom from '../../companion-cloud/room.js';
import type { ChatHistoryState } from '@cindy/maker-shared/chat-history';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

const selfId = '30000000-0000-4000-8000-000000000001';
const botActor = '20000000-0000-4000-8000-000000000001';
const roomId = '10000000-0000-4000-8000-000000000001';
const sourceId = '50000000-0000-4000-8000-000000000001';
const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: roomId, source_message_id: sourceId,
  bot_id: botActor, requester_id: selfId, context_seq: '1', epoch: 1, status: 'running', access_mode: 'owner', access_revision: 1 };

describe('Chat Server cloud companions', () => {
  let service: BotGroupChatService;
  let deps: BotGroupChatServiceDeps;
  let host: CompanionCloudHost & { deliverToCanonical: ReturnType<typeof vi.fn> };
  let me: Record<string, unknown>;
  let home: string | null;
  let patch: (body: unknown) => { status?: number; body: unknown };
  let claimed: boolean;
  let directMembers: Array<{ id: string; state: string }>;
  const calls = (route: string, method?: string) => fixture.handle.mock.calls.filter(([r, m]) => r === route && (!method || m === method));

  function respond(route: string, method: string, body: unknown) {
    if (route === '/me') return { body: me };
    if (route === '/actors' && method === 'GET') return { body: [{ id: botActor, kind: 'bot', externalId: 'local-bot', name: 'Mia', homeDeviceId: home }] };
    if (route === `/actors/${botActor}` && method === 'PATCH') return patch(body);
    if (route === '/executions/claim') { const next = claimed ? null : execution; claimed = true; return { body: { execution: next } }; }
    if (route === `/conversations/${roomId}/snapshot`) return { body: { room: { id: roomId, kind: 'direct', name: 'Mia', revision: 1 }, members: directMembers, messages: [], cursor: '1' } };
    if (route === `/conversations/${roomId}/messages/${sourceId}`) return { body: { id: sourceId, seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' },
      deleted: false, threadRootId: null, createdAt: '2026-10-13T00:00:00Z', content: [{ type: 'text', text: 'hi' }, { type: 'media', mediaId: sourceId, caption: 'a.png' }] } };
    if (route === '/preferences') return { body: [] };
    return { body: {} };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.profiles = [{ id: 'local-bot', displayName: 'Mia', avatar: null, status: 'active' }];
    fixture.sockets = [];
    me = { actor: { id: selfId }, deviceId: 'desk-1', capabilities: { companionHome: true, directRoomClaim: true } };
    home = null; claimed = false;
    directMembers = [{ id: selfId, state: 'joined' }, { id: botActor, state: 'joined' }];
    patch = () => { home = 'desk-1'; return { body: { id: botActor, homeDeviceId: 'desk-1' } }; };
    fixture.handle.mockImplementation((route, method, body) => respond(route, method, body));
    const files = new Map<string, string>();
    host = {
      homes: createCompanionHomeRegistry(),
      openState: (_endpoint, _human, current) => createCompanionCloudState({ filePath: 'state.json', current,
        io: { read: path => files.get(path) ?? null, write: (path, contents) => { files.set(path, contents); } } }),
      readValues: async () => [], canonicalSession: async () => null, rowsAfter: async () => [], latestRows: async () => [],
      deliverToCanonical: vi.fn(async () => ({ ok: true as const })),
    };
    deps = { ensureLane: vi.fn(), abortLane: vi.fn(async () => {}), dispatch: vi.fn(), companionCloud: host } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); });

  // PR #7242, unit: production transcript paging must reuse a scan, but still
  // observe delta edits, reset and revoked access. Existing room tests bypassed this injection.
  it('reuses a checked transcript for older pages and revalidates changes before reusing it', async () => {
    claimed = true;
    const scans = vi.spyOn(chatRoom, 'readAllRoomMessages');
    const saved = new Map<string, ChatHistoryState>();
    deps.chatHistoryStore = () => ({
      read: async room => structuredClone(saved.get(room)),
      write: async (room, state) => { if (state) saved.set(room, structuredClone(state)); else saved.delete(room); },
    });
    const message = (seq: number, text = `text ${seq}`) => ({ id: `m${seq}`, seq: String(seq), authorId: selfId,
      createdAt: new Date(seq * 1000).toISOString(), content: [{ type: 'text', text }] });
    let cursor = '1', mode: 'same' | 'edit' | 'reset' | 'forbidden' = 'same';
    fixture.handle.mockImplementation((route, method, body) => {
      if (route === '/conversations') return { body: { id: roomId } };
      if (route.endsWith('/snapshot')) return { body: { room: { id: roomId, kind: 'direct' }, messages: [], cursor } };
      if (route.includes('/messages?')) {
        const before = Number(new URL(`https://fixture${route}`).searchParams.get('before') ?? 111);
        return { body: Array.from({ length: 110 }, (_, i) => message(110 - i, mode === 'reset' ? 'reset' : undefined))
          .filter(m => Number(m.seq) < before).slice(0, 100) };
      }
      if (route.startsWith('/changes?')) {
        if (mode === 'forbidden') return { status: 403, body: { error: { code: 'FORBIDDEN' } } };
        if (mode === 'reset') return { status: 409, body: { error: { code: 'RESET_REQUIRED' } } };
        return { body: { cursor, changes: mode === 'edit' ? [{ type: 'message.updated', data: { message: { ...message(1, 'edited'), revision: 2 } } }] : [] } };
      }
      return respond(route, method, body);
    });
    await vi.advanceTimersByTimeAsync(2000);
    const runtime = activeCompanionCloud()!;
    const first = await runtime.transcript('local-bot');
    const reads = () => fixture.handle.mock.calls.filter(([route]) => route.startsWith('/changes?') || route.includes('/messages?')).length;
    const initialReads = reads();
    expect((await runtime.transcript('local-bot', first.nextBefore)).messages).toHaveLength(10);
    expect(reads()).toBe(initialReads);
    expect(scans).toHaveBeenCalledTimes(1);

    cursor = '2'; mode = 'edit'; vi.setSystemTime(Date.now() + 31_000);
    expect((await runtime.transcript('local-bot', first.nextBefore)).messages[0]!.text).toBe('edited');
    expect(reads()).toBe(initialReads + 1);
    expect(scans).toHaveBeenCalledTimes(2);
    cursor = '3'; mode = 'reset'; vi.setSystemTime(Date.now() + 31_000);
    expect((await runtime.transcript('local-bot', first.nextBefore)).messages[0]!.text).toBe('reset');
    mode = 'forbidden'; vi.setSystemTime(Date.now() + 31_000);
    await expect(runtime.transcript('local-bot', first.nextBefore)).rejects.toThrow('FORBIDDEN');
  });

  it('claims an empty home for this computer once', async () => {
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(`/actors/${botActor}`, 'PATCH').map(call => call[2])).toEqual([{ homeDeviceId: 'desk-1', expectedHomeDeviceId: null }]);
    expect(host.homes.snapshot()).toMatchObject({ enabled: true, selfDeviceId: 'desk-1', humanActorId: selfId,
      actors: [{ id: botActor, externalId: 'local-bot', homeDeviceId: 'desk-1' }] });
    expect(host.homes.isHomeHere('local-bot')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(`/actors/${botActor}`, 'PATCH')).toHaveLength(1);
    expect(calls('/executions/claim').length).toBeGreaterThan(1);
  });

  it('drops the previous owner\'s companion homes as soon as the service is touched after an account switch', async () => {
    service.dispose();
    let owner = 'a';
    deps = { ...deps, captureOwnerScope: () => owner, isOwnerScopeCurrent: (scope: unknown) => scope === owner } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.homes.snapshot().actors).toHaveLength(1);
    owner = 'b';
    void service.chatServer;
    expect(host.homes.snapshot().actors).toEqual([]);
  });

  it('claims nothing while the home could not be registered yet', async () => {
    claimed = true;
    patch = () => ({ status: 503, body: { error: { code: 'UNAVAILABLE' } } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(`/actors/${botActor}`, 'PATCH').length).toBeGreaterThan(0);
    expect(calls('/executions/claim')).toHaveLength(0);
    // Registration is retried by the 60s actor refresh, not the former 5s cadence.
    // A failed home registration must still fence claims throughout that interval.
    patch = () => { home = 'desk-1'; return { body: { id: botActor, homeDeviceId: 'desk-1' } }; };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls('/executions/claim')).toHaveLength(0);
    expect(calls(`/actors/${botActor}`, 'PATCH')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(calls('/executions/claim').length).toBeGreaterThan(0);
  });

  it('adopts another computer as home and stops claiming its work', async () => {
    patch = () => { home = 'laptop'; return { status: 409, body: { error: { code: 'HOME_DEVICE_CONFLICT', details: { homeDeviceId: 'laptop' } } } }; };
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.homes.homeOf('local-bot')).toBe('laptop');
    expect(host.homes.isHomeHere('local-bot')).toBe(false);
    // The local copy is demoted: hidden from the roster, no routines, no uploads.
    expect(host.homes.snapshot().demotedBotIds).toEqual(['local-bot']);
    expect(host.homes.isShadowed('local-bot')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('/executions/claim')).toHaveLength(0);
  });

  it('publishes each companion\'s name on its own, so one broken avatar never blocks the others', async () => {
    const broken = '60000000-0000-4000-8000-0000000000b2';
    fixture.profiles = [{ id: 'broken-bot', displayName: 'Bad', avatar: 'cindy-media://missing', status: 'active' },
      { id: 'local-bot', displayName: 'Mia (renamed)', avatar: null, status: 'active' }];
    home = 'desk-1'; claimed = true;
    fixture.handle.mockImplementation((route, method, body) => route === '/actors' && method === 'GET'
      ? { body: [{ id: broken, kind: 'bot', externalId: 'broken-bot', name: 'Bad', homeDeviceId: 'desk-1' },
        { id: botActor, kind: 'bot', externalId: 'local-bot', name: 'Mia', homeDeviceId: 'desk-1' }] }
      : respond(route, method, body));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(`/actors/${botActor}/profile`, 'POST').map(call => call[2])).toEqual([expect.objectContaining({ name: 'Mia (renamed)' })]);
    expect(calls(`/actors/${broken}/profile`, 'POST')).toHaveLength(0);
  });

  it('publishes the name only from the home, after the home is known', async () => {
    fixture.profiles = [{ id: 'local-bot', displayName: 'Mia (renamed)', avatar: null, status: 'active' }];
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    const order = fixture.handle.mock.calls.map(([route, method]) => `${method} ${route}`);
    expect(order.indexOf(`POST /actors/${botActor}/profile`)).toBeGreaterThan(order.indexOf(`PATCH /actors/${botActor}`));
  });

  it('never publishes the name or avatar from a copy whose home is another computer', async () => {
    fixture.profiles = [{ id: 'local-bot', displayName: 'Mia (stale copy)', avatar: null, status: 'active' }];
    home = 'laptop';
    claimed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(`/actors/${botActor}/profile`)).toHaveLength(0);
    expect(host.homes.isShadowed('local-bot')).toBe(true);
  });

  it('never publishes the name or avatar from an installation not confirmed as the home one', async () => {
    service.dispose();
    host = { ...host, homes: createCompanionHomeRegistry(), installationId: () => 'install-b' } as typeof host;
    deps = { ...deps, companionCloud: host } as BotGroupChatServiceDeps;
    home = 'desk-1';
    fixture.profiles = [{ id: 'local-bot', displayName: 'Mia (other install)', avatar: null, status: 'active' }];
    // The other Cindy installation on this computer runs the companion.
    fixture.handle.mockImplementation((route, method, body) => route === '/preferences' && method === 'GET'
      ? { body: [{ key: 'companion.install.v1', value: { installationId: 'install-a', deviceId: 'desk-1' }, revision: 1 }] }
      : respond(route, method, body));
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    claimed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(`/actors/${botActor}/profile`)).toHaveLength(0);
    expect(calls('/executions/claim')).toHaveLength(0);
  });

  it('keeps a demoted copy shadowed from the persisted list before the server answers', async () => {
    service.dispose();
    const persisted = { ids: ['local-bot'] };
    host = { ...host, homes: createCompanionHomeRegistry(),
      shadows: { read: () => persisted.ids, write: (ids: string[]) => { persisted.ids = ids; } } } as typeof host;
    deps = { ...deps, companionCloud: host } as BotGroupChatServiceDeps;
    fixture.handle.mockImplementation(() => { throw new Error('server unreachable'); });
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.homes.isShadowed('local-bot')).toBe(true);
    expect(host.homes.snapshot()).toMatchObject({ enabled: false, demotedBotIds: ['local-bot'] });
  });

  it('retries saving the demotion until it reaches the disk', async () => {
    service.dispose();
    const writes: string[][] = [];
    let failing = true;
    host = { ...host, homes: createCompanionHomeRegistry(), shadows: { read: () => [], write: (ids: string[]) => {
      writes.push(ids);
      if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    } } } as typeof host;
    deps = { ...deps, companionCloud: host } as BotGroupChatServiceDeps;
    patch = () => { home = 'laptop'; return { status: 409, body: { error: { code: 'HOME_DEVICE_CONFLICT', details: { homeDeviceId: 'laptop' } } } }; };
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
    await vi.advanceTimersByTimeAsync(2000);
    // Hidden right away even though the list could not be saved.
    expect(host.homes.isShadowed('local-bot')).toBe(true);
    expect(writes).toContainEqual(['local-bot']);
    failing = false;
    const attempts = writes.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes.length).toBeGreaterThan(attempts);
    expect(writes.at(-1)).toEqual(['local-bot']);
    // Saved: not written again while unchanged.
    const saved = writes.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toHaveLength(saved);
  });

  it('stays inert on a server without companion homes', async () => {
    me = { actor: { id: selfId } };
    claimed = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.handle.mock.calls.filter(([route, method]) => route.startsWith('/actors/') && method === 'PATCH')).toHaveLength(0);
    expect(calls('/preferences')).toHaveLength(0);
    expect(host.homes.snapshot().enabled).toBe(false);
    expect(host.homes.isHomeHere('local-bot')).toBe(true);
  });

  it('delivers a 1:1 room message to the canonical Session and completes without content', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    // The server only hands 1:1 room work to a claim that declares it can run it.
    expect(calls('/executions/claim')[0]![2]).toMatchObject({ directRoomVersion: 1, accessPolicyVersion: 1, planVersion: 1 });
    expect(host.deliverToCanonical).toHaveBeenCalledWith('local-bot', 'hi\n[附件: a.png]', `chat-direct:${execution.id}:${sourceId}`);
    expect(deps.ensureLane).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    const results = fixture.handle.mock.calls.filter(([route, , body]) => route === `/conversations/${roomId}/executions/${execution.id}`
      && ['complete', 'fail'].includes(body?.action));
    expect(results).toHaveLength(1);
    expect(results[0]![2]).toMatchObject({ action: 'complete', continueDiscussion: false });
    expect(results[0]![2]).not.toHaveProperty('content');
    expect(results[0]![3]).toBe(botActor);
  });

  it('claims without directRoomVersion from a server that does not offer the capability', async () => {
    me = { ...me, capabilities: { companionHome: true } };
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('/executions/claim').length).toBeGreaterThan(0);
    for (const call of calls('/executions/claim')) expect(call[2]).not.toHaveProperty('directRoomVersion');
  });

  it('never declares 1:1 room work from a copy that cannot hand it to the main task', async () => {
    me = { ...me, capabilities: { directRoomClaim: true } };
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('/executions/claim').length).toBeGreaterThan(0);
    for (const call of calls('/executions/claim')) expect(call[2]).not.toHaveProperty('directRoomVersion');
  });

  it('never treats someone else\'s 1:1 room as the companion\'s own room', async () => {
    directMembers = [{ id: selfId, state: 'joined' }, { id: '60000000-0000-4000-8000-000000000009', state: 'joined' }];
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.deliverToCanonical).not.toHaveBeenCalled();
    expect(deps.ensureLane).not.toHaveBeenCalled();
    const results = fixture.handle.mock.calls.filter(([route, , body]) => route === `/conversations/${roomId}/executions/${execution.id}`
      && ['complete', 'fail'].includes(body?.action));
    expect(results.map(call => call[2].action)).toEqual(['fail']);
  });

  it('fails the execution with a short reason when the main task does not accept it', async () => {
    host.deliverToCanonical.mockResolvedValue({ ok: false, errorCode: 'TARGET_BOT_INACTIVE' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    const results = fixture.handle.mock.calls.filter(([route, , body]) => route === `/conversations/${roomId}/executions/${execution.id}`
      && ['complete', 'fail'].includes(body?.action));
    expect(results.map(call => call[2].action)).toEqual(['fail']);
    expect(typeof results[0]![2].detail).toBe('string');
  });

  it('re-reads homes immediately when the actor stream reports a move', async () => {
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.homes.homeOf('local-bot')).toBe('desk-1');
    const socket = fixture.sockets[0]!;
    socket.emit('message', JSON.stringify({ type: 'ready' }));
    home = 'laptop';
    const before = calls('/me').length;
    socket.emit('message', JSON.stringify({ type: 'changes', scope: `actor:${selfId}`, cursor: '2',
      changes: [{ type: 'actor.changed', entityId: botActor, data: { homeDeviceId: 'laptop' } }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('/me').length).toBe(before + 1);
    expect(host.homes.homeOf('local-bot')).toBe('laptop');
  });
});
