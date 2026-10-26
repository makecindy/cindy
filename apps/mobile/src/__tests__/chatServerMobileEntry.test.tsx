// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn(), getAccessToken: vi.fn(async () => 'fixture') },
  link: { status: 'offline', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(),
    getPresenceAvailability: (): boolean => false, onRemoteResourceChanged: () => () => {}, subscribe: vi.fn(), unsubscribe: vi.fn() },
  legacy: { items: [] as any[], loading: false, refreshing: false, error: null as string | null, isOnline: vi.fn(() => false), refresh: vi.fn() },
  targets: [] as { deviceId: string; deviceName: string }[],
  disk: new Map<string, string>(),
  foreground: new Set<(state: string) => void>(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async (key: string) => h.disk.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { h.disk.set(key, value); }), removeItem: vi.fn(async (key: string) => { h.disk.delete(key); }), getAllKeys: vi.fn(async () => [...h.disk.keys()]), multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(key => h.disk.delete(key)); }) } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-operation-id' }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => { h.foreground.add(fn); return { remove: () => h.foreground.delete(fn) }; } } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (fn: any) => useEffect(fn, [fn]) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global', getMobileEndpointForRealm: () => 'https://chat.example.invalid', loadMobileEndpointsForRealm: vi.fn() }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => new Set() }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.legacy }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
import { useBotGroupChat } from '@/session/useBotGroupChat';
import { useBotGroupRoster } from '@/session/useBotGroupRoster';
import { botGroupRoute } from '@/session/botGroupNavigation';
import { isRemoteResourceUnread, clearRemoteResourceCache, readCachedChatRoster } from '@/device-link/remoteResourceCache';
const id = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const room = { id, name: 'Discussion', kind: 'group', state: 'joined', revision: 1, archived: false,
  created_at: '2026-10-01', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' };
const host = { deviceId: '', deviceName: '' };
let root: Root | undefined;
let roster: ReturnType<typeof useBotGroupRoster>;
let chat: ReturnType<typeof useBotGroupChat>;
let showChat = false;
function Probe() { roster = useBotGroupRoster(h.targets, !showChat); chat = useBotGroupChat(host, showChat ? id : ''); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(async () => {
  await clearRemoteResourceCache(); h.auth.user.id = 'owner';
  vi.clearAllMocks(); h.foreground.clear(); showChat = false; h.auth.accountGeneration = 1; h.legacy.items = []; h.targets = []; h.legacy.isOnline.mockReturnValue(false);
  vi.stubGlobal('WebSocket', class { close() {} });
  h.auth.apiFetch.mockImplementation(async (path: string, options: any) => {
    options.assertCurrent();
    if (path.startsWith('/v1/conversations?')) return [room];
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' } };
    if (path.endsWith('/members')) return [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }];
    if (path.endsWith('/snapshot')) return { room, members: [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }], messages: [], cursor: '1' };
    if ((path.endsWith('/executions') || path.includes('/execution-failures?'))) return [];
    if (path.includes('/messages?')) return [{ id: self, seq: '9007199254740993', authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: 'Fixture message' }], createdAt: '2026-10-09', deleted: false, threadRootId: null }];
    if (path.endsWith('/messages')) return { id: self };
    throw new Error('Unexpected request');
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
it('shows safe execution failures through the direct phone entry and removes them after retry', async () => {
  const original = h.auth.apiFetch.getMockImplementation()!;
  let status = 'failed';
  h.auth.apiFetch.mockImplementation(async (path, options) => (path.endsWith('/executions') || path.includes('/execution-failures?'))
    ? [{ id, source_message_id: self, bot_id: self, epoch: 1, status, failure_code: 'AUTH_REQUIRED', detail: { message: 'private diagnostic' } }]
    : original(path, options));
  showChat = true; await render();
  expect(chat.state.kind).toBe('ready');
  if (chat.state.kind !== 'ready') throw new Error('Expected ready group');
  expect(chat.state.group.messages).toHaveLength(2);
  expect(chat.state.group.messages[1]).toMatchObject({ id: `execution-failure:${id}:1`, runtimeFailureCode: 'AUTH_REQUIRED' });
  expect(chat.state.group.lastMessage?.preview).toBe('Fixture message');
  expect(JSON.stringify(chat.state.group)).not.toContain('private diagnostic');
  expect(h.link.invoke).not.toHaveBeenCalled();
  status = 'queued';
  await act(async () => { chat.reload(); });
  if (chat.state.kind !== 'ready') throw new Error('Expected ready group after retry');
  expect(chat.state.group.messages).toHaveLength(1);
});
it('lists and opens an existing joined server group with all computers and the relay offline', async () => {
  await render();
  expect(roster.items).toHaveLength(1);
  expect(botGroupRoute(roster.items[0].host, id)).toEqual({ pathname: '/companions/groups/[groupId]', params: { groupId: id } });
  showChat = true; await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { id, messages: [{ content: 'Fixture message' }] } });
  expect(chat.online).toBe(true);
  expect(h.link.invoke).not.toHaveBeenCalled(); expect(h.link.openLink).not.toHaveBeenCalled();
  expect(h.auth.apiFetch.mock.calls.every(([, options]) => options.baseUrl === 'https://chat.example.invalid')).toBe(true);
  await act(async () => { await chat.act('send', { text: 'hello', clientId: 'fixture-operation', mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST', body: { operationId: 'fixture-operation', content: [{ type: 'text', text: 'hello' }], mentions: [] } }));
});
it('never includes the current human actor in explicit or everyone server mentions', async () => {
  const other = '00000000-0000-4000-8000-000000000003';
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    const value = await original(path, options);
    if (path.endsWith('/members')) return [...value, { ...value[0], id: other, name: 'Other', ownerActorId: other }];
    return path.endsWith('/snapshot') ? { ...value, members: [...value.members, { ...value.members[0], id: other, name: 'Other', ownerActorId: other }] } : value;
  });
  showChat = true; await render();
  for (const all of [false, true]) {
    await act(async () => { await chat.act('send', { text: 'hello', clientId: `fixture-${all}`, mentions: { all, botIds: [self, other] } }); });
    expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST', body: { operationId: `fixture-${all}`, content: [{ type: 'text', text: 'hello' }], mentions: [other] } }));
  }
});
it('imports read_seq and acknowledges only displayed incoming messages with their exact sequences', async () => {
  await clearRemoteResourceCache();
  const first = '9007199254740992', second = '9007199254740993';
  const messages = [first, second].map((seq, index) => ({ id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`, seq, authorId: id,
    author: { kind: 'human', name: 'Other' }, content: [{ type: 'text', text: 'hello' }],
    createdAt: '2026-10-09T10:00:00.123Z', deleted: false, threadRootId: null }));
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/read')) return { readSeq: options.body.readSeq };
    if (path.includes('/messages?')) return messages;
    const value = await original(path, options);
    return path.endsWith('/snapshot') ? { ...value, messages, cursor: second, reads: [{ thread_key: 'main', read_seq: first }] } : value;
  });
  await render();
  const row = roster.items[0];
  const unread = () => isRemoteResourceUnread('owner', '', id, row.item.display.lastReplyAt, row.lastReplySequence);
  expect(unread()).toBe(true);
  showChat = true; await render();
  await act(async () => { await chat.markRead!([messages[0].id, 'unseen-id']); });
  expect(unread()).toBe(true);
  await act(async () => { await chat.markRead!([messages[0].id, messages[1].id]); });
  expect(unread()).toBe(false);
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/read`, expect.objectContaining({
    method: 'POST', body: { operationId: `read-main:${second}`, readSeq: second },
  }));
  await act(async () => { await chat.markRead!([messages[0].id, messages[1].id]); });
  expect(h.auth.apiFetch.mock.calls.filter(([path]) => path.endsWith('/read'))).toHaveLength(1);
});
it('resolves everyone using authorized members at send time instead of the displayed snapshot', async () => {
  const joined = '00000000-0000-4000-8000-000000000003';
  const invited = '00000000-0000-4000-8000-000000000004';
  const left = '00000000-0000-4000-8000-000000000005';
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/members')) {
      const [member] = await original(path, options);
      return [member, { ...member, id: joined, kind: 'bot', name: 'New teammate' },
        { ...member, id: invited, state: 'invited' }, { ...member, id: left, state: 'left' }];
    }
    return original(path, options);
  });
  showChat = true; await render();
  await act(async () => { await chat.act('send', { text: 'everyone', clientId: 'fixture-new-member', mentions: { all: true, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST', body: { operationId: 'fixture-new-member', content: [{ type: 'text', text: 'everyone' }], mentions: [joined] } }));
});

it.each([
  ['human', false], ['human', true], ['bot', false], ['bot', true],
] as const)('refuses any unavailable explicit %s target before sending (everyone=%s)', async (kind, all) => {
  const target = '00000000-0000-4000-8000-000000000003';
  const available = '00000000-0000-4000-8000-000000000004';
  const original = h.auth.apiFetch.getMockImplementation()!;
  let membership = 'joined';
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    const value = await original(path, options);
    const members = [{ id: target, kind, state: membership, name: 'Ann', ownerActorId: self, ownerName: '', role: 'member', avatar: null },
      { id: available, kind: 'bot', state: 'joined', name: 'Available', ownerActorId: self, ownerName: '', role: 'member', avatar: null }];
    if (path.endsWith('/members')) return [...value, ...members.filter(member => member.state !== 'missing')];
    return path.endsWith('/snapshot') ? { ...value, members: [...value.members, ...members] } : value;
  });
  showChat = true; await render();
  for (membership of ['left', 'removed', 'banned', 'invited', 'missing']) {
    for (const botIds of [[target], [available, target]]) {
      await act(async () => {
        await expect(chat.act('send', { text: '@Ann hello', clientId: 'fixture-stale-target', mentions: { all, botIds } }))
          .rejects.toThrow('MENTION_UNAVAILABLE');
      });
      expect(chat.online).toBe(true);
      expect(chat.state.kind).toBe('ready');
      expect(h.auth.apiFetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
    }
  }
  await act(async () => {
    await chat.act('send', { text: '@Available hello', clientId: 'fixture-reselected', mentions: { all, botIds: [available] } });
  });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({
    method: 'POST', body: { operationId: 'fixture-reselected', content: [{ type: 'text', text: '@Available hello' }], mentions: [available] },
  }));
});

it('keeps REST sending available after the group WebSocket disconnects', async () => {
  vi.useFakeTimers();
  const sockets: any[] = [];
  vi.stubGlobal('WebSocket', class {
    readyState = 1; onclose?: Function;
    constructor() { sockets.push(this); }
    close() { this.onclose?.({}); }
  });
  showChat = true; await render();
  expect(chat.online).toBe(true);
  await act(async () => { sockets[0].close(); });
  expect(chat.online).toBe(true);
  await act(async () => { await chat.act('send', { text: 'REST works', clientId: 'fixture-ws-offline', mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST' }));
  h.auth.apiFetch.mockRejectedValue(new Error('REST offline'));
  await act(async () => { chat.reload(); });
  expect(chat.online).toBe(false);
});

it.each([403, 404])('clears revoked access immediately when a send returns %s', async (status) => {
  showChat = true; await render();
  expect(chat.state.kind).toBe('ready');
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/messages')) throw Object.assign(new Error('NOT_MEMBER'), { status });
    return original(path, options);
  });
  await act(async () => {
    await expect(chat.act('send', { text: 'fixture', clientId: 'fixture-revoked', mentions: { all: false, botIds: [] } })).rejects.toMatchObject({ status });
  });
  expect(chat.state.kind).toBe('missing');
  expect(chat.online).toBe(false);
  await expect(chat.act('send', { text: 'again', clientId: 'fixture-no-page', mentions: { all: false, botIds: [] } })).rejects.toThrow('CHAT_READ_FAILED');
});
it.each([403, 404])('clears revoked access when attachment authorization returns %s', async (status) => {
  showChat = true; await render();
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.includes('/media/')) throw Object.assign(new Error('NOT_MEMBER'), { status });
    return original(path, options);
  });
  await act(async () => { await expect(chat.media!(self)).rejects.toMatchObject({ status }); });
  expect(chat.state.kind).toBe('missing');
  expect(chat.online).toBe(false);
});
it('keeps authorized history when only the attachment is missing', async () => {
  showChat = true; await render();
  h.auth.apiFetch.mockRejectedValue(Object.assign(new Error('MEDIA_NOT_FOUND'), { status: 404, code: 'MEDIA_NOT_FOUND' }));
  await act(async () => { await expect(chat.media!(self)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' }); });
  expect(chat.state.kind).toBe('ready'); expect(chat.online).toBe(true);
});
it('clears access on everyone member-read rejection and ignores an older authorized history reply', async () => {
  showChat = true; await render();
  const original = h.auth.apiFetch.getMockImplementation()!;
  let finish!: () => void;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/members')) throw Object.assign(new Error('NOT_MEMBER'), { status: 403 });
    const value = await original(path, options);
    if (path.endsWith('/snapshot')) await new Promise<void>(resolve => { finish = resolve; });
    return value;
  });
  await act(async () => { chat.reload(); });
  await act(async () => {
    await expect(chat.act('send', { text: 'everyone', clientId: 'fixture-member-rejected', mentions: { all: true, botIds: [] } })).rejects.toMatchObject({ status: 403 });
  });
  expect(chat.state.kind).toBe('missing');
  expect(h.auth.apiFetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  await act(async () => { finish(); });
  expect(chat.state.kind).toBe('missing');
  h.auth.apiFetch.mockImplementation(original);
  await act(async () => { chat.reload(); });
  expect(chat.state.kind).toBe('ready');
});
it('deduplicates server copies from multiple computers while retaining a local legacy group', async () => {
  h.legacy.items = ['mac', 'pc'].map(deviceId => ({ key: deviceId, host: { deviceId, deviceName: deviceId }, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1', display: { title: 'Discussion' }, links: [] } }));
  h.legacy.isOnline.mockReturnValue(true);
  h.targets = ['mac', 'pc'].map(deviceId => ({ deviceId, deviceName: deviceId }));
  h.legacy.items.push({ ...h.legacy.items[0], key: 'local', item: { ...h.legacy.items[0].item, ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'old-local-group' } } });
  await render(); expect(roster.items.map(row => row.item.ref.id)).toEqual([id, 'old-local-group']);
  expect(roster.items[0].host.deviceId).toBe('');
  h.auth.apiFetch.mockImplementation(async path => path === '/v1/me' ? { actor: { id: self, kind: 'human' } } : []);
  await act(async () => { await roster.refresh(); });
  expect(roster.items.map(row => row.item.ref.id)).toEqual(['old-local-group']);
});
// Regression: desktop archive was honored by neither mobile list path. Keep the
// server ID for deduplication even when the room must not become a visible row.
it.each(['list', 'snapshot'] as const)('keeps an archived %s out on cold load, refresh and foreground, including old computer copies', async source => {
  const allowed = h.auth.apiFetch.getMockImplementation()!;
  const legacyHost = { deviceId: 'old-computer', deviceName: 'Old' };
  h.targets = [legacyHost]; h.legacy.isOnline.mockReturnValue(true);
  h.legacy.items = [{ host: legacyHost, item: { ref: { id, kind: 'bot-group', collectionId: 'bot-groups' } } }];
  let archived = true;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.startsWith('/v1/conversations?')) return [{ ...room, archived: source === 'list' && archived }];
    const value = await allowed(path, options);
    return path.endsWith('/snapshot') ? { ...value, room: { ...room, archived } } : value;
  });
  await render();
  expect(roster.items).toEqual([]);
  if (source === 'list') expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/snapshot'))).toBe(false);
  await act(async () => { await roster.refresh(); });
  await act(async () => h.foreground.forEach(fn => fn('active')));
  expect(roster.items).toEqual([]);
  archived = false;
  await act(async () => { await roster.refresh(); });
  expect(roster.items).toHaveLength(1);
  expect(roster.items[0].host.deviceId).toBe('');
  archived = true;
  await act(async () => { await roster.refresh(); });
  expect(roster.items).toEqual([]);
  h.auth.apiFetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await roster.refresh(); });
  expect(roster.items).toEqual([]);
});
it('clears removed membership, exposes first-read failures and recovers on foreground', async () => {
  showChat = true; h.auth.apiFetch.mockRejectedValue(new Error('offline'));
  await render(); expect(chat.state.kind).toBe('error');
  h.auth.apiFetch.mockImplementation(async path => path === '/v1/me' ? { actor: { id: self, kind: 'human' } } : path.endsWith('/snapshot') ? { room, members: [], messages: [], cursor: '1' } : []);
  await act(async () => h.foreground.forEach(fn => fn('active')));
  expect(chat.state.kind).toBe('ready');
  h.auth.apiFetch.mockRejectedValue(Object.assign(new Error('NOT_MEMBER'), { status: 403 }));
  await act(async () => { chat.reload(); }); expect(chat.state.kind).toBe('missing');
});
it('ignores an old account response after switching accounts', async () => {
  let finish!: (value: unknown) => void;
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation((path, options) => path.startsWith('/v1/conversations?') ? new Promise(resolve => { finish = resolve; }) : original(path, options));
  await render(); h.auth.user.id = 'other'; h.auth.accountGeneration++; h.auth.apiFetch.mockResolvedValue([]); await render();
  await act(async () => finish([room])); expect(roster.items).toEqual([]);
});


it('does not restore unverified computer cache rows on a cold offline mount', async () => {
  h.targets = [{ deviceId: 'mac', deviceName: 'Mac' }];
  h.legacy.items = [{ key: 'cached', host: h.targets[0], item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1', display: { title: 'Removed' }, links: [] } }];
  h.auth.apiFetch.mockImplementation(async path => path === '/v1/me' ? { actor: { id: self, kind: 'human' } } : []);
  await render(); expect(roster.items).toEqual([]);
});


it('rebuilds realtime after membership returns while the same group page remains open', async () => {
  vi.useFakeTimers();
  const sockets: any[] = [];
  vi.stubGlobal('WebSocket', class {
    readyState = 1; onopen?: Function; onmessage?: Function; onclose?: Function; onerror?: Function;
    send = vi.fn();
    constructor() { sockets.push(this); }
    close() { this.onclose?.({}); }
  });
  const receive = async (socket: any, value: unknown) => {
    await act(async () => { socket.onmessage({ data: JSON.stringify(value) }); });
  };
  showChat = true; await render();
  await receive(sockets[0], { type: 'ready', actorId: self });
  const allowed = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockRejectedValue(Object.assign(new Error('NOT_MEMBER'), { status: 403 }));
  await receive(sockets[0], { type: 'scope_error', scope: `conversation:${id}`, error: { code: 'NOT_MEMBER' } });
  expect(chat.state.kind).toBe('missing');
  h.auth.apiFetch.mockImplementation(allowed);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(sockets).toHaveLength(2);
  await receive(sockets[1], { type: 'ready', actorId: self });
  expect(sockets[1].send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', scope: `conversation:${id}`, after: '1' }));
  const previous = h.auth.apiFetch.mock.calls.length;
  await receive(sockets[1], { type: 'changes', scope: `conversation:${id}`, cursor: '2', changes: [] });
  expect(h.auth.apiFetch.mock.calls.length).toBeGreaterThan(previous);
  expect(chat.state.kind).toBe('ready');
});

it('exposes an actor-scope personal hide to the current screen and clears it after an account switch', async () => {
  vi.useFakeTimers();
  h.auth.accountGeneration = 105;
  const sockets: any[] = [];
  vi.stubGlobal('WebSocket', class {
    readyState = 1; onopen?: Function; onmessage?: Function; onclose?: Function; onerror?: Function;
    send = vi.fn();
    constructor() { sockets.push(this); }
    close() { this.onclose?.({}); }
  });
  const allowed = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' }, capabilities: { conversationListStateVersion: 1 } };
    if (path.startsWith('/v1/conversation-list-state?')) return [];
    if (path.startsWith('/v1/changes?')) return { head: '10' };
    return allowed(path, options);
  });
  showChat = true; await render();
  await act(async () => { sockets[0].onmessage({ data: JSON.stringify({ type: 'ready', actorId: self }) }); });
  expect(chat.listHidden).toBe(false);
  await act(async () => { sockets[0].onmessage({ data: JSON.stringify({ type: 'changes', scope: `actor:${self}`, cursor: '11', changes: [
    { type: 'conversation.list.changed', data: { conversationId: id, hidden: true, revision: 1 } },
  ] }) }); });
  expect(chat.state.kind).toBe('missing');
  expect(chat.listHidden).toBe(true);
  expect(h.auth.apiFetch.mock.calls.some(([path, options]) => path.endsWith('/list-state') && options.method === 'POST')).toBe(false);
  h.auth.accountGeneration++;
  await render();
  expect(chat.listHidden).toBe(false);
});

it('supports direct leave, then personal removal independently without a readable snapshot', async () => {
  h.auth.accountGeneration = 101;
  const allowed = h.auth.apiFetch.getMockImplementation()!;
  let left = false;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    options.assertCurrent();
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' }, capabilities: { groupLifecycleVersion: 1, conversationListStateVersion: 1 } };
    if (path.startsWith('/v1/conversation-list-state?')) return [];
    if (path.endsWith('/members') && options.method === 'POST') { left = true; return { revision: 2 }; }
    if (path.endsWith('/list-state')) return { conversationId: id, hidden: true, revision: 1 };
    if (left && path.endsWith('/snapshot')) throw Object.assign(new Error('NOT_MEMBER'), { status: 403 });
    return allowed(path, options);
  });
  showChat = true; await render();
  expect(chat.state.kind).toBe('ready');
  expect(chat.state.kind === 'ready' && chat.state.group.supportsListRemoval).toBe(true);
  await act(async () => { await chat.act('leave'); });
  expect(chat.state.kind).toBe('missing');
  h.auth.apiFetch.mockClear();
  await act(async () => { await chat.act('hide'); });
  expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/snapshot'))).toBe(false);
  expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/list-state'))).toBe(true);
});
it('keeps a hidden room out of the roster even if an old server list and computer cache contain it', async () => {
  h.auth.accountGeneration = 102;
  const allowed = h.auth.apiFetch.getMockImplementation()!;
  const legacyHost = { deviceId: 'old-computer', deviceName: 'Old' };
  h.targets = [legacyHost]; h.legacy.isOnline.mockReturnValue(true);
  h.legacy.items = [{ host: legacyHost, item: { ref: { id, kind: 'bot-group', collectionId: 'bot-groups' } } }];
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' }, capabilities: { conversationListStateVersion: 1 } };
    if (path.startsWith('/v1/conversation-list-state?')) return [{ conversationId: id, hidden: true, revision: 4 }];
    return allowed(path, options);
  });
  await render();
  expect(roster.items).toEqual([]);
  expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/snapshot'))).toBe(false);
  expect(roster.error).toBeNull();
  await act(async () => { await roster.refresh(); });
  await act(async () => h.foreground.forEach(fn => fn('active')));
  expect(roster.items).toEqual([]);
});

it('merges a computer-confirmed personal removal without requiring direct server access or trusting stale room data', async () => {
  h.auth.accountGeneration = 103;
  h.link.status = 'online';
  h.link.subscribe.mockResolvedValue(undefined); h.link.unsubscribe.mockResolvedValue(undefined);
  h.link.getPresenceAvailability = () => true;
  h.auth.apiFetch.mockRejectedValue(new Error('Offline direct endpoint'));
  const target = { deviceId: 'computer', deviceName: 'Computer' };
  const resource = { ref: { id, collectionId: 'bot-groups', kind: 'bot-group' }, revision: '1', display: { title: 'Fixture' }, links: [],
    blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '', data: { id, name: 'Fixture', serverBacked: true,
      supportsListRemoval: true, members: [], messages: [], plans: [], round: { status: 'idle', speakers: [], canContinue: false } } }] };
  h.link.invoke.mockImplementation(async (_id, channel) => channel === 'maker:remote-resources:get' ? resource
    : { effects: [], result: { listState: { conversationId: id, hidden: true, revision: 7 } } });
  function RemoteProbe() { chat = useBotGroupChat(target, id); return null; }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(RemoteProbe)));
  expect(chat.state.kind).toBe('ready');
  await act(async () => { await chat.act('hide'); });
  expect(chat.state.kind).toBe('missing');
  expect(h.auth.apiFetch).not.toHaveBeenCalled();
  expect(h.link.invoke.mock.calls.find(call => call[1] === 'maker:remote-resources:invoke')?.[2][0]).toMatchObject({ actionId: 'hide', resourceRef: { id } });
  await act(async () => root!.unmount()); root = undefined;
  h.targets = [target]; h.legacy.isOnline.mockReturnValue(true);
  h.legacy.items = [{ host: target, item: { ref: { id, kind: 'bot-group', collectionId: 'bot-groups' } } }];
  await render();
  expect(roster.items).toEqual([]);
  h.link.status = 'offline'; h.link.getPresenceAvailability = () => false;
});

// Regression: cold startup previously discarded every server group until the complete
// list + snapshot fanout returned. Exercise the actual hook across a disk restore (unit).
it('restores group summaries and member avatars before HTTP, retains them offline, and replaces them authoritatively', async () => {
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    const value = await original(path, options);
    return path.endsWith('/snapshot') ? { ...value, members: [{ ...value.members[0], avatar: 'https://avatars.example.invalid/member.png' }], messages: [
      { id: 'message', seq: '8', authorId: 'other', author: { kind: 'human', name: 'Other' }, content: [{ type: 'text', text: 'Last discussion' }], createdAt: '2026-10-09', deleted: false, threadRootId: null },
    ] } : value;
  });
  await render();
  const saved = h.disk.get('cindy.remoteResources.v1.owner')!;
  act(() => root!.unmount()); root = undefined;
  await clearRemoteResourceCache(); h.disk.set('cindy.remoteResources.v1.owner', saved);
  h.auth.accountGeneration++;
  let reject!: (error: Error) => void;
  h.auth.apiFetch.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await render();
  expect(roster.items).toMatchObject([{ key: `chat:${id}`, item: { display: { preview: 'Last discussion' } }, groupMembers: [{ avatarUrl: 'https://avatars.example.invalid/member.png' }], lastReplySequence: '8' }]);
  await act(async () => reject(new Error('offline')));
  expect(roster.items[0].item.display.preview).toBe('Last discussion');
  // A single snapshot timeout must not erase its known preview or group mark.
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/snapshot')) throw new Error('timeout');
    return original(path, options);
  });
  const links = roster.items[0].item.links;
  expect(links).not.toEqual([]);
  await act(async () => roster.refresh());
  expect(roster.items[0].item.display.preview).toBe('Last discussion');
  expect(roster.items[0].item.links).toEqual(links);
  expect((await readCachedChatRoster('owner', 'global'))?.items[0].item.links).toEqual(links);
  h.auth.apiFetch.mockImplementation(async (path, options) => path.startsWith('/v1/conversations?') ? [] : original(path, options));
  await act(async () => roster.refresh());
  expect(roster.items).toEqual([]);
  expect(await readCachedChatRoster('owner', 'global')).toEqual({ items: [], ids: [id] });
});
it('does not project a cached server group into another account or realm', async () => {
  await render();
  expect((await readCachedChatRoster('owner', 'global'))?.items).toHaveLength(1);
  expect(await readCachedChatRoster('owner', 'cn')).toBeNull();
  h.auth.user.id = 'other'; h.auth.accountGeneration++;
  h.auth.apiFetch.mockRejectedValue(new Error('offline'));
  await render();
  expect(roster.items).toEqual([]);
});

it('removes a saved roster row when opening the group confirms revoked membership', async () => {
  await render();
  expect((await readCachedChatRoster('owner', 'global'))?.items).toHaveLength(1);
  h.auth.apiFetch.mockRejectedValue(Object.assign(new Error('NOT_MEMBER'), { status: 403 }));
  showChat = true; await render();
  expect(chat.state.kind).toBe('missing');
  expect((await readCachedChatRoster('owner', 'global'))?.items).toEqual([]);
  act(() => root!.unmount()); root = undefined; showChat = false;
  h.auth.apiFetch.mockRejectedValue(new Error('offline'));
  await render();
  expect(roster.items).toEqual([]);
});

// Review regression (unit): an absent cache must not settle the first empty screen
// while HTTP is pending; an authoritative saved empty list may render immediately.
it.each(['missing', 'empty', 'read-error'] as const)('keeps initial loading correct with %s cache', async mode => {
  if (mode === 'empty') h.disk.set('cindy.remoteResources.v1.owner', JSON.stringify({ chatRosters: { global: { items: [], ids: [] } } }));
  if (mode === 'read-error') {
    const { default: storage } = await import('@react-native-async-storage/async-storage');
    vi.mocked(storage.getItem).mockRejectedValueOnce(new Error('read failed'));
  }
  const original = h.auth.apiFetch.getMockImplementation()!;
  let finish!: (rooms: typeof room[]) => void;
  h.auth.apiFetch.mockImplementation((path, options) => path.startsWith('/v1/conversations?')
    ? new Promise(resolve => { finish = resolve; }) : original(path, options));
  await render();
  expect(roster.items).toEqual([]);
  expect(roster.loading).toBe(mode !== 'empty');
  await act(async () => finish([]));
  expect(roster.loading).toBe(false);
});
