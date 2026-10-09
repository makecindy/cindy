// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn(), getAccessToken: vi.fn(async () => 'fixture') },
  link: { status: 'offline', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(),
    getPresenceAvailability: () => false, onRemoteResourceChanged: () => () => {}, subscribe: vi.fn(), unsubscribe: vi.fn() },
  legacy: { items: [] as any[], loading: false, refreshing: false, error: null as string | null, isOnline: vi.fn(() => false), refresh: vi.fn() },
  targets: [] as { deviceId: string; deviceName: string }[],
  foreground: new Set<(state: string) => void>(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}) } }));
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
import { isRemoteResourceUnread, clearRemoteResourceCache } from '@/device-link/remoteResourceCache';
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
beforeEach(() => {
  vi.clearAllMocks(); h.foreground.clear(); showChat = false; h.auth.accountGeneration = 1; h.legacy.items = []; h.targets = []; h.legacy.isOnline.mockReturnValue(false);
  vi.stubGlobal('WebSocket', class { close() {} });
  h.auth.apiFetch.mockImplementation(async (path: string, options: any) => {
    options.assertCurrent();
    if (path.startsWith('/v1/conversations?')) return [room];
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' } };
    if (path.endsWith('/members')) return [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }];
    if (path.endsWith('/snapshot')) return { room, members: [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }], messages: [], cursor: '1' };
    if (path.includes('/messages?')) return [{ id: self, seq: '9007199254740993', authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: 'Fixture message' }], createdAt: '2026-10-09', deleted: false, threadRootId: null }];
    if (path.endsWith('/messages')) return { id: self };
    throw new Error('Unexpected request');
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
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
  const messages = [first, second].map((seq, index) => ({ id: `incoming-${index}`, seq, authorId: id,
    author: { kind: 'human', name: 'Other' }, content: [{ type: 'text', text: 'hello' }],
    createdAt: '2026-10-09T10:00:00.123Z', deleted: false, threadRootId: null }));
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.includes('/messages?')) return messages;
    const value = await original(path, options);
    return path.endsWith('/snapshot') ? { ...value, messages, cursor: second, reads: [{ thread_key: 'main', read_seq: first }] } : value;
  });
  await render();
  const row = roster.items[0];
  const unread = () => isRemoteResourceUnread('owner', '', id, row.item.display.lastReplyAt, row.lastReplySequence);
  expect(unread()).toBe(true);
  showChat = true; await render();
  await act(async () => { await chat.markRead!(['incoming-0', 'unseen-id']); });
  expect(unread()).toBe(true);
  await act(async () => { await chat.markRead!(['incoming-0', 'incoming-1']); });
  expect(unread()).toBe(false);
  expect(h.auth.apiFetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
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
  h.auth.apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); h.auth.accountGeneration++; h.auth.apiFetch.mockResolvedValue([]); await render();
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
