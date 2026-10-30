// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn(), getAccessToken: vi.fn(async () => 'fixture') },
  link: { status: 'offline', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(),
    getPresenceAvailability: (): boolean => false, onRemoteResourceChanged: () => () => {}, subscribe: vi.fn(), unsubscribe: vi.fn() },
  legacy: { items: [] as any[], loading: false, refreshing: false, error: null as string | null, isOnline: vi.fn(() => false), refresh: vi.fn() },
  targets: [] as { deviceId: string; deviceName: string }[],
  disk: new Map<string, string>(),
  history: new Map<string, string>(),
  historyWriteFails: false,
  foreground: new Set<(state: string) => void>(),
  put: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (key: string) => h.history.get(key) ?? null,
  write: async (key: string, value: string) => { if (h.historyWriteFails) throw new Error('disk full'); h.history.set(key, value); },
  remove: async (key: string) => { h.history.delete(key); },
  files: async () => [...h.history.keys()],
}) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async (key: string) => h.disk.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { h.disk.set(key, value); }), removeItem: vi.fn(async (key: string) => { h.disk.delete(key); }), getAllKeys: vi.fn(async () => [...h.disk.keys()]), multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(key => h.disk.delete(key)); }) } }));
vi.mock('@/session/mobileDurableOutbox', async () => {
  const { createDurableOutbox } = await import('@/session/durableOutbox');
  const { default: storage } = await import('@react-native-async-storage/async-storage');
  return { mobileDurableOutbox: createDurableOutbox(storage) };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-operation-id' }));
vi.mock('@/session/mobileAttachmentUpload', () => ({ putMobileAttachmentUploadFromFile: (...args: unknown[]) => h.put(...args) }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => { h.foreground.add(fn); return { remove: () => h.foreground.delete(fn) }; } } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useIsFocused: () => true, useFocusEffect: (fn: any) => useEffect(fn, [fn]) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global', getMobileEndpointForRealm: () => 'https://chat.example.invalid', loadMobileEndpointsForRealm: vi.fn() }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => new Set() }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.legacy }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
import { useBotGroupChat } from '@/session/useBotGroupChat';
import { useBotGroupRoster } from '@/session/useBotGroupRoster';
import { botGroupRoute } from '@/session/botGroupNavigation';
import { mobileDurableOutbox } from '@/session/mobileDurableOutbox';
import { createDurableOutbox } from '@/session/durableOutbox';
import { enqueueChatMessage } from '@/chat/chatOutbox';
import { createChatOutboxDelivery } from '@/chat/chatOutbox';
import { createChatServerClient } from '@/chat/chatServerClient';
import { forgetChatMessages } from '@/chat/chatMessageCache';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { peekChatMessages, readChatMessages } from '@/chat/chatMessageCache';
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
let threadRootId: string | undefined;
function Probe() { roster = useBotGroupRoster(h.targets, !showChat); chat = useBotGroupChat(host, showChat ? id : '', threadRootId); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
async function send(input: Record<string, unknown>) {
  await chat.act('send', input);
  const runner = createChatOutboxDelivery({ store: mobileDurableOutbox,
    client: createChatServerClient((path, method = 'GET', body) => h.auth.apiFetch(`/v1${path}`, { method, body, baseUrl: 'https://chat.example.invalid', assertCurrent() {} })),
    current: () => true, canRun: () => true, accessLost: forgetChatMessages });
  await runner.run();
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(async () => {
  h.historyWriteFails = false;
  setMobileAuthOwner(null); peekChatMessages(id); await clearHistoryDisk();
  await clearRemoteResourceCache(); h.auth.user.id = 'owner';
  await mobileDurableOutbox.activate(''); h.disk.clear(); h.history.clear(); setMobileAuthOwner('owner');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  vi.clearAllMocks(); h.foreground.clear(); showChat = false; threadRootId = undefined; h.auth.accountGeneration = 1; h.legacy.items = []; h.targets = []; h.legacy.isOnline.mockReturnValue(false);
  h.put.mockImplementation(async () => {});
  vi.stubGlobal('WebSocket', class { close() {} });
  h.auth.apiFetch.mockImplementation(async (path: string, options: any) => {
    options.assertCurrent();
    if (path.startsWith('/v1/conversations?')) return [room];
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' } };
    if (path.startsWith('/v1/changes?')) return { head: '1', cursor: '1', changes: [], hasMore: false };
    if (path.endsWith('/members')) return [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }];
    if (path.endsWith('/snapshot')) return { room, members: [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }], messages: [], cursor: '1' };
    if ((path.endsWith('/executions') || path.includes('/execution-failures?'))) return [];
    if (path.includes('/messages?')) return [{ id: self, seq: '9007199254740993', authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: 'Fixture message' }], createdAt: '2026-10-09', deleted: false, threadRootId: null }];
    if (path.endsWith('/messages')) return { id: self };
    throw new Error('Unexpected request');
  });
});
// Regression: entering a saved group must not depend on Chat Server latency.
// Integration tier: real hook, real disk store, controlled native IO / HTTP.
it('reopens saved history offline from memory and disk, and purges it after membership loss', async () => {
  setMobileAuthOwner('owner'); showChat = true; await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { messages: [{ content: 'Fixture message' }] } });
  await act(async () => { root!.unmount(); root = undefined; });
  h.auth.apiFetch.mockImplementation(() => new Promise(() => {}));
  await render();
  expect(chat.state.kind).toBe('ready');
  await act(async () => { root!.unmount(); root = undefined; });
  // A new account generation drops the JS cache; the same account can still read its disk.
  setMobileAuthOwner(null); peekChatMessages(id); setMobileAuthOwner('owner');
  await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { messages: [{ content: 'Fixture message' }] } });
  h.auth.apiFetch.mockRejectedValue({ status: 403 });
  // Restart the mounted request too, since its earlier HTTP read intentionally never resolves.
  await act(async () => { root!.unmount(); root = undefined; });
  await render();
  expect(chat.state.kind).toBe('missing');
  await act(async () => { root!.unmount(); root = undefined; });
  setMobileAuthOwner(null); peekChatMessages(id); setMobileAuthOwner('owner');
  h.auth.apiFetch.mockImplementation(() => new Promise(() => {}));
  await render();
  expect(chat.state.kind).toBe('loading');
});
it('does not show one account\'s saved group to another account', async () => {
  setMobileAuthOwner('owner'); showChat = true; await render();
  await act(async () => { root!.unmount(); root = undefined; });
  setMobileAuthOwner('other'); h.auth.user.id = 'other'; h.auth.accountGeneration++;
  h.auth.apiFetch.mockImplementation(() => new Promise(() => {}));
  await render();
  expect(chat.state.kind).toBe('loading');
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

// #7847 review: real hook/client pagination must survive a concurrent summary read.
// Existing root-loss tests never completed hydration between starting and finishing an older page (unit).
it('keeps an older page when thread summary hydration finishes while it is loading', async () => {
  const initial = Array.from({ length: 100 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(300 - index).padStart(12, '0')}`, seq: String(300 - index),
    authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: `Message ${index}` }],
    createdAt: '2026-10-09', deleted: false, threadRootId: null, ...(index === 0 ? { replyCount: 2 } : {}),
  }));
  const older = { ...initial[0], id: '00000000-0000-4000-8000-000000000200', seq: '200', content: [{ type: 'text', text: 'Older page arrived' }] };
  let finishPreview!: (rows: unknown[]) => void;
  let finishOlder!: (rows: unknown[]) => void;
  const preview = new Promise<unknown[]>(resolve => { finishPreview = resolve; });
  const previousPage = new Promise<unknown[]>(resolve => { finishOlder = resolve; });
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation((path, options) => {
    if (path.endsWith('/snapshot')) return Promise.resolve({ room, members: [], messages: initial, cursor: '300' });
    if (path.startsWith('/v1/changes?')) return Promise.resolve({ head: '300', cursor: '300', changes: [], hasMore: false });
    if (path.includes('/messages?') && path.includes('threadRootId=')) return preview;
    if (path.includes('/messages?') && path.includes('before=')) return previousPage;
    if (path.includes('/messages?')) return Promise.resolve(initial);
    return original(path, options);
  });
  showChat = true; await render();
  expect(chat.state.kind).toBe('ready');
  let loading!: Promise<void>;
  await act(async () => { loading = chat.loadOlder!(); });
  expect(chat.loadingOlder).toBe(true);
  await act(async () => { finishPreview([{ ...initial[0], id: '00000000-0000-4000-8000-000000000301', seq: '301', threadRootId: initial[0].id }]); });
  await act(async () => { finishOlder([older]); await loading; });
  expect(chat.state).toMatchObject({ kind: 'ready', group: { hasMoreBefore: false } });
  if (chat.state.kind !== 'ready') throw new Error('Expected paged group');
  expect(chat.state.group.messages.some(message => message.content === 'Older page arrived')).toBe(true);
  expect(chat.state.group.messages.find(message => message.id === initial[0].id)?.threadPreview?.replies)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: '00000000-0000-4000-8000-000000000301' })]));
  expect(chat.loadingOlder).toBe(false);
});

// #7847: the real hook must retain an older thread page when following changes during the request.
// Unit: the hydration regression above does not exercise the follow acknowledgement and reload.
it.each([false, true])('settles following without losing a concurrent older page (pagination fails=%s)', async paginationFails => {
  const initial = Array.from({ length: 100 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(300 - index).padStart(12, '0')}`, seq: String(300 - index),
    authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: `Reply ${index}` }],
    createdAt: '2026-10-09', deleted: false, threadRootId: id,
  }));
  const older = { ...initial[0], id: '00000000-0000-4000-8000-000000000200', seq: '200', content: [{ type: 'text', text: 'Older reply arrived' }] };
  const threadRoot = { ...initial[0], id, seq: '1', threadRootId: null };
  let finishOlder!: (rows: unknown[]) => void;
  let failOlder!: (error: Error) => void;
  const previousPage = new Promise<unknown[]>((resolve, reject) => { finishOlder = resolve; failOlder = reject; });
  let following = true;
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation((path, options) => {
    if (path.endsWith('/snapshot')) return Promise.resolve({ room, members: [], messages: [], cursor: '300',
      reads: [{ thread_key: id, read_seq: '0', following }] });
    if (path.endsWith('/read')) { following = options.body.following; return Promise.resolve({ following }); }
    if (path.startsWith('/v1/changes?')) return Promise.resolve({ head: '300', cursor: '300', changes: [], hasMore: false });
    if (path.endsWith(`/messages/${id}`)) return Promise.resolve(threadRoot);
    if (path.includes('/messages?') && path.includes('before=')) return previousPage;
    if (path.includes('/messages?')) return Promise.resolve(initial);
    return original(path, options);
  });
  showChat = true; threadRootId = id; await render();
  let loading!: Promise<void>;
  let unfollowing!: Promise<boolean>;
  let loadResult!: Promise<unknown>;
  await act(async () => { loading = chat.loadOlder!(); loadResult = loading.catch(error => error); });
  await act(async () => { unfollowing = chat.followThread!(false); });
  expect(following).toBe(false);
  await act(async () => {
    if (paginationFails) failOlder(new Error('network unavailable'));
    else finishOlder([older]);
    await loadResult; await unfollowing;
  });
  expect(await loadResult).toEqual(paginationFails ? new Error('network unavailable') : undefined);
  expect(chat.state).toMatchObject({ kind: 'ready', group: { hasMoreBefore: paginationFails } });
  if (chat.state.kind !== 'ready') throw new Error('Expected paged thread');
  expect(chat.state.group.messages.some(message => message.content === 'Older reply arrived')).toBe(!paginationFails);
  expect(chat.threadMeta?.following).toBe(false);
  expect(chat.loadingOlder).toBe(false);
});

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
  await act(async () => { await send({ text: 'hello', clientId: 'fixture-operation', mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST', body: { operationId: 'fixture-operation', content: [{ type: 'text', text: 'hello' }], mentions: [] } }));
});
// #6907: the hook must pass direct-room scope to the real client's quote projection (unit tier).
it('keeps the account owner label when quoting from a direct phone entry', async () => {
  const botId = '00000000-0000-4000-8000-000000000003';
  const owner = { id: self, kind: 'human', state: 'joined', name: 'Nickname A', ownerActorId: self, ownerName: '', role: 'member', avatar: null };
  const bot = { ...owner, id: botId, kind: 'bot', name: 'Companion X', ownerName: 'Account B' };
  const message = { id: self, seq: '1', authorId: botId, author: { kind: 'bot', name: bot.name }, content: [{ type: 'text', text: 'Example' }],
    createdAt: '2026-10-09', deleted: false, threadRootId: null };
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/snapshot')) return { room: { ...room, kind: 'direct' }, members: [owner, bot], messages: [message], cursor: '1' };
    if (path.endsWith('/members')) return [owner, bot];
    if (path.endsWith('/messages/' + self)) return message;
    return original(path, options);
  });
  showChat = true; await render();
  expect(chat.state.kind).toBe('ready');
  await act(async () => { await send({ text: 'Agreed', clientId: 'direct-quote-scope', quote: { messageId: self }, mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith('/v1/conversations/' + id + '/messages', expect.objectContaining({ method: 'POST', body: expect.objectContaining({
    mentions: [botId], content: [expect.objectContaining({ data: expect.objectContaining({ authorName: 'Companion X (Account B)' }) }), { type: 'text', text: 'Agreed' }],
  }) }));
});
it.each(['', 'look at this'])('uploads and sends direct media with all computers offline, text=%s', async text => {
  const mediaId = '00000000-0000-4000-8000-000000000003';
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/media')) return { id: mediaId, uploadUrl: 'https://upload.example.invalid/signed' };
    if (path.endsWith('/complete')) return {};
    return original(path, options);
  });
  showChat = true; await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { supportsAttachments: true } });
  const attachment = await chat.uploadAttachment!({ name: 'photo.jpg', mimeType: 'image/jpeg', size: 42 }, 'file:///photo', { token: 'fixture' });
  const input = { clientId: 'same-media-send', text, mentions: { all: false, botIds: [] }, attachments: [attachment] };
  await act(async () => { await send(input); });
  const posts = h.auth.apiFetch.mock.calls.filter(([path]) => path.endsWith('/messages'));
  expect(posts).toHaveLength(1);
  expect(posts[0][1].body).toEqual({ operationId: 'same-media-send', mentions: [],
    content: [...(text ? [{ type: 'text', text }] : []), { type: 'media', mediaId, caption: 'photo.jpg' }] });
  expect(h.put).toHaveBeenCalledWith('https://upload.example.invalid/signed', 'file:///photo', 'image/jpeg', {},
    { signal: undefined, signedHeaders: { 'Content-Type': 'image/jpeg' } });
  expect(h.link.invoke).not.toHaveBeenCalled(); expect(h.link.openLink).not.toHaveBeenCalled();
});

it('clears a group when the upload prepare rejects its membership', async () => {
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/media')) throw Object.assign(new Error('NOT_MEMBER'), { status: 403 });
    return original(path, options);
  });
  showChat = true; await render();
  await act(async () => {
    await expect(chat.uploadAttachment!({ name: 'a.pdf', size: 42 }, 'file:///picked', { token: 'fixture' })).rejects.toMatchObject({ status: 403 });
  });
  expect(chat.state.kind).toBe('missing');
  expect(h.put).not.toHaveBeenCalled();
});

it('refuses a late PUT result after account changes before media completion', async () => {
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => path.endsWith('/media')
    ? { id: self, uploadUrl: 'https://upload.example.invalid/signed' } : original(path, options));
  h.put.mockImplementation(async () => { h.auth.accountGeneration++; await render(); });
  showChat = true; await render();
  const upload = chat.uploadAttachment!;
  await expect(upload({ name: 'a.pdf', size: 42 }, 'file:///picked', { token: 'fixture' })).rejects.toThrow('OWNER_CHANGED');
  expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  expect(h.auth.apiFetch.mock.calls.some(([path]) => path.endsWith('/messages'))).toBe(false);
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
    await act(async () => { await send({ text: 'hello', clientId: `fixture-${all}`, mentions: { all, botIds: [self, other] } }); });
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
// Unit: conversation head is unchanged by another device's personal read position.
// The actual roster refresh must replace snapshot.reads even when message delta is empty.
it.each(['refresh', 'read-event', 'reconnect'] as const)('refreshes personal read metadata with an unchanged room head on %s', async trigger => {
  const sockets: Array<{ onmessage: ((event: { data: string }) => void) | null; send: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('WebSocket', class {
    readyState = 1; onmessage = null; onopen = null; onclose = null; onerror = null;
    send = vi.fn(); close() {}
    constructor() { sockets.push(this); }
  });
  const frame = async (value: unknown) => { await act(async () => { sockets.at(-1)!.onmessage!({ data: JSON.stringify(value) }); }); };
  let readSeq = '0';
  const reply = { id: self, seq: '5', authorId: id, author: { kind: 'human', name: 'Other' },
    content: [{ type: 'text', text: 'reply' }], createdAt: '2026-10-09T10:00:00Z', deleted: false, threadRootId: id };
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.startsWith('/v1/conversations?')) return [{ ...room, head: '5' }];
    if (path.includes('/changes?')) return { head: '5', cursor: '5', changes: [], hasMore: false };
    const value = await original(path, options);
    return path.endsWith('/snapshot') ? { ...value, messages: [reply], cursor: '5', reads: [
      { thread_key: 'main', read_seq: '0' }, { thread_key: id, read_seq: readSeq, following: true },
    ] } : value;
  });
  await render();
  const unread = () => (roster.items[0].chatUnread?.threadCount ?? 0) > 0;
  expect(unread()).toBe(true);
  await frame({ type: 'ready', actorId: self });
  expect(sockets[0].send.mock.calls.some(([body]) => JSON.parse(body).type === 'subscribe')).toBe(true);
  readSeq = '5';
  if (trigger === 'refresh') await act(async () => { await roster.refresh(); });
  else if (trigger === 'read-event') await frame({ type: 'changes', scope: `actor:${self}`, cursor: '6',
    changes: [{ type: 'read.changed', entityId: id, data: {} }] });
  else {
    await act(async () => { for (const listener of h.foreground) listener('active'); });
    await frame({ type: 'ready', actorId: self });
  }
  expect(unread()).toBe(false);
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
  await act(async () => { await send({ text: 'everyone', clientId: 'fixture-new-member', mentions: { all: true, botIds: [] } }); });
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
        await send({ text: '@Ann hello', clientId: 'fixture-stale-target', mentions: { all, botIds } });
        expect(mobileDurableOutbox.getSnapshot()[0]).toMatchObject({ state: 'failed', error: 'MENTION_UNAVAILABLE' });
        await mobileDurableOutbox.remove(mobileDurableOutbox.getSnapshot()[0]);
      });
      expect(chat.online).toBe(true);
      expect(chat.state.kind).toBe('ready');
      expect(h.auth.apiFetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
    }
  }
  await act(async () => {
    await send({ text: '@Available hello', clientId: 'fixture-reselected', mentions: { all, botIds: [available] } });
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
  await act(async () => { await send({ text: 'REST works', clientId: 'fixture-ws-offline', mentions: { all: false, botIds: [] } }); });
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
    await send({ text: 'fixture', clientId: 'fixture-revoked', mentions: { all: false, botIds: [] } });
    expect(mobileDurableOutbox.getSnapshot()[0]).toMatchObject({ state: 'failed', suspended: true });
  });
  expect(chat.state.kind).toBe('missing');
  expect(chat.online).toBe(false);
  await expect(send({ text: 'again', clientId: 'fixture-no-page', mentions: { all: false, botIds: [] } })).rejects.toThrow('CHAT_READ_FAILED');
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
    if (path.startsWith('/v1/changes?')) await new Promise<void>(resolve => { finish = resolve; });
    return value;
  });
  await act(async () => { chat.reload(); });
  await act(async () => {
    await send({ text: 'everyone', clientId: 'fixture-member-rejected', mentions: { all: true, botIds: [] } });
    expect(mobileDurableOutbox.getSnapshot()[0]).toMatchObject({ state: 'failed', suspended: true });
  });
  expect(chat.state.kind).toBe('missing');
  expect(h.auth.apiFetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  await act(async () => { finish(); });
  expect(chat.state.kind).toBe('missing');
  h.auth.apiFetch.mockImplementation(original);
  await act(async () => { chat.reload(); });
  expect(chat.state.kind).toBe('ready');
});
it('deduplicates computer copies before the server roster discovers a new group', async () => {
  h.auth.accountGeneration++;
  h.targets = ['mac', 'pc'].map(deviceId => ({ deviceId, deviceName: deviceId }));
  h.legacy.isOnline.mockReturnValue(true);
  h.legacy.items = h.targets.map(host => ({ key: host.deviceId, host, item: {
    ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1', display: { title: 'Discussion' }, links: [],
  } }));
  const original = h.auth.apiFetch.getMockImplementation()!;
  let finish!: (rooms: typeof room[]) => void;
  const pending = new Promise<typeof room[]>(resolve => { finish = resolve; });
  h.auth.apiFetch.mockImplementation((path, options) => path.startsWith('/v1/conversations?') ? pending : original(path, options));
  await render();
  expect(roster.items.map(row => row.item.ref.id)).toEqual([id]);
  expect(roster.items[0].host.deviceId).toBe('mac');
  await act(async () => { finish([room]); });
  expect(roster.items.map(row => row.item.ref.id)).toEqual([id]);
  expect(roster.items[0].host.deviceId).toBe('');
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
    if (path.startsWith('/v1/changes?scope=actor:')) return { head: '10' };
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

// Integration: the actual ledger and HTTP adapter survive a process restart after
// a committed POST loses its response. Existing direct-send tests cannot cover it.
it.each([false, true])('persists the exact uncertain send across restart and never rebuilds its recipients (media=%s)', async withMedia => {
  const storage = { getAllKeys: async () => [...h.disk.keys()], getItem: async (key: string) => h.disk.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.disk.set(key, value); }, removeItem: async (key: string) => { h.disk.delete(key); } };
  const account = getMobileAuthOwner().accountKey;
  let store = createDurableOutbox(storage); await store.activate(account);
  const attachments = withMedia ? [{ id, name: 'report.pdf', path: '', ext: 'pdf', size: 42, mimeType: 'application/pdf', category: 'file' as const }] : [];
  await enqueueChatMessage(store, account, id, { clientId: 'lost-response', text: 'saved offline', mentions: { all: true, botIds: [] }, attachments }, 1);
  expect(store.getSnapshot()[0]).toMatchObject({ state: 'queued', item: { text: 'saved offline' } });
  const posted: unknown[] = [];
  let memberReads = 0;
  const client = createChatServerClient(async <T,>(path: string, method?: string, body?: unknown): Promise<T> => {
    if (path === '/me') return { actor: { id: self, kind: 'human' } } as T;
    if (path.endsWith('/members')) { memberReads++; return [{ id: self, state: 'joined' }, { id, state: 'joined' }] as T; }
    if (method === 'POST') { posted.push(body); if (posted.length === 1) throw new Error('response lost'); return { id: self } as T; }
    throw new Error('Unexpected request');
  });
  const delivery = () => createChatOutboxDelivery({ store, client, current: () => true, canRun: () => true, accessLost: async () => {} });
  await delivery().run();
  expect(store.getSnapshot()[0]).toMatchObject({ state: 'queued', enqueueStarted: true, chat: { body: { operationId: 'lost-response', mentions: [id] } } });
  expect(posted[0]).toMatchObject({ content: [{ type: 'text', text: 'saved offline' }, ...(withMedia ? [{ type: 'media', mediaId: id, caption: 'report.pdf' }] : [])] });
  store = createDurableOutbox(storage); await store.activate(account);
  expect(store.getSnapshot()[0].chat?.input.attachments).toEqual(attachments);
  await delivery().run();
  expect(posted).toHaveLength(2); expect(posted[1]).toEqual(posted[0]); expect(memberReads).toBe(1);
  expect(store.getSnapshot()[0]).toMatchObject({ state: 'confirming', chat: { messageId: self } });
  await store.activate('other-account'); expect(store.getSnapshot()).toEqual([]);
});

// Review regression (integration): a definitive first-POST rejection is safe to cancel,
// but a rejection after an unknown earlier outcome cannot revoke its dedup identity.
it.each([400, 403])('can cancel a definitely refused %s send after reload and unblock the next message', async status => {
  showChat = true; await render();
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/messages') && options?.method === 'POST') throw Object.assign(new Error('Rejected'), { status });
    return original(path, options);
  });
  await act(async () => { await send({ text: 'rejected', clientId: 'rejected-first', mentions: { all: false, botIds: [] } }); });
  expect(mobileDurableOutbox.getSnapshot()[0]).toMatchObject({ state: 'failed', enqueueStarted: false });
  // Reauthorize/reopen the same group; do not silently send the suspended draft.
  h.auth.apiFetch.mockImplementation(original);
  await act(async () => { chat.reload(); });
  const account = getMobileAuthOwner().accountKey;
  await act(async () => { await mobileDurableOutbox.activate(''); await mobileDurableOutbox.activate(account); });
  await act(async () => { await chat.pendingAction!('rejected-first', 'cancel'); });
  expect(mobileDurableOutbox.getSnapshot()).toEqual([]);
  await act(async () => { await send({ text: 'next', clientId: 'after-cancel', mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch.mock.calls.filter(([path, options]) => path.endsWith('/messages') && options?.method === 'POST'
    && options.body.operationId === 'after-cancel')).toHaveLength(1);
  expect(mobileDurableOutbox.getSnapshot().some(row => row.item.clientId === 'rejected-first')).toBe(false);
});

it('keeps an uncertain send frozen and uncancellable when a later attempt is rejected', async () => {
  showChat = true; await render();
  const original = h.auth.apiFetch.getMockImplementation()!;
  let attempt = 0;
  const posted: unknown[] = [];
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith('/messages') && options?.method === 'POST') {
      posted.push(options.body); attempt++;
      if (attempt === 1) throw new Error('response lost');
      throw Object.assign(new Error('Rejected later'), { status: 400 });
    }
    return original(path, options);
  });
  await act(async () => { await send({ text: 'uncertain', clientId: 'uncertain-first', mentions: { all: false, botIds: [] } }); });
  await act(async () => {
    await expect(chat.pendingAction!('uncertain-first', 'cancel')).rejects.toThrow('MESSAGE_ALREADY_SENDING');
    // The background runner retries the already frozen POST using its original ID.
    const client = createChatServerClient((path, method = 'GET', body) => h.auth.apiFetch(`/v1${path}`, { method, body, assertCurrent() {} }));
    await createChatOutboxDelivery({ store: mobileDurableOutbox, client, current: () => true, canRun: () => true, accessLost: forgetChatMessages }).run();
  });
  expect(posted).toHaveLength(2); expect(posted[1]).toEqual(posted[0]);
  expect(mobileDurableOutbox.getSnapshot()[0]).toMatchObject({ state: 'failed', enqueueStarted: true });
  await expect(chat.pendingAction!('uncertain-first', 'cancel')).rejects.toThrow('MESSAGE_ALREADY_SENDING');
});


// D2 root-404 regression: real mobile entry -> HTTP client -> memory/disk cache.
// Existing membership tests only reject the whole room, not an authorized reply
// page followed by a missing root. This integration-tier fixture distinguishes
// the exact thread lookup exception from room-wide access loss.
it('keeps main history in memory and on disk when only the thread root is missing', async () => {
  showChat = true; await render();
  expect(peekChatMessages(id)?.page.messages[0]?.id).toBe(self);
  await act(async () => { root!.unmount(); root = undefined; });
  const original = h.auth.apiFetch.getMockImplementation()!;
  const replyId = '00000000-0000-4000-8000-000000000003';
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (path.endsWith(`/messages/${self}`)) throw { status: 404, code: 'MESSAGE_NOT_FOUND' };
    if (path.includes('/messages?') && path.includes(`threadRootId=${self}`)) return [{
      id: replyId, seq: '9007199254740994', authorId: self, author: { kind: 'human', name: 'Me' },
      content: [{ type: 'text', text: 'Still authorized reply' }], createdAt: '2026-10-09', deleted: false, threadRootId: self,
    }];
    return original(path, options);
  });
  threadRootId = self; await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { messages: [{ id: replyId, content: 'Still authorized reply' }] } });
  expect(peekChatMessages(id)?.page.messages[0]?.id).toBe(self);
  expect(peekChatMessages(id, self)?.page.messages.map(message => message.id)).toEqual([replyId]);
  await act(async () => { root!.unmount(); root = undefined; });
  // Discard JS memory without deleting this account's persisted conversations.
  setMobileAuthOwner(null); peekChatMessages(id); setMobileAuthOwner('owner');
  expect((await readChatMessages(id))?.page.messages[0]?.id).toBe(self);
});

it.each([
  { thread: true, status: 403, code: 'MESSAGE_NOT_FOUND' },
  { thread: true, status: 404, code: 'CONVERSATION_NOT_FOUND' },
  { thread: true, status: 404, code: 'OTHER_NOT_FOUND' },
  { thread: false, status: 404, code: 'MESSAGE_NOT_FOUND' },
])('still clears room history for $status/$code outside an exact missing thread root (thread=$thread)', async ({ thread, status, code }) => {
  showChat = true; await render();
  expect(peekChatMessages(id)).not.toBeNull();
  await act(async () => { root!.unmount(); root = undefined; });
  const original = h.auth.apiFetch.getMockImplementation()!;
  h.auth.apiFetch.mockImplementation(async (path, options) => {
    if (thread ? path.endsWith(`/messages/${self}`) : path.startsWith('/v1/changes?')) throw { status, code };
    if (path.includes('/messages?') && path.includes(`threadRootId=${self}`)) return [];
    return original(path, options);
  });
  threadRootId = thread ? self : undefined; await render();
  expect(chat.state.kind).toBe('missing');
  expect(peekChatMessages(id)).toBeNull();
  expect(peekChatMessages(id, self)).toBeNull();
  await act(async () => { root!.unmount(); root = undefined; });
  setMobileAuthOwner(null); peekChatMessages(id); setMobileAuthOwner('owner');
  expect(await readChatMessages(id)).toBeNull();
});

// PC parity delivery, integration: the real durable ledger and account runner.
// A confirmed reply plus a failed second POST must survive page settlement and
// restart without ever re-sending the reply; prior media tests lack this second stage.
it('restores a failed share after restart, keeps its body, and does not block later replies', async () => {
  const { settleChatOutbox } = await import('@/chat/chatOutbox');
  const storage = { getAllKeys: async () => [...h.disk.keys()], getItem: async (key: string) => h.disk.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.disk.set(key, value); }, removeItem: async (key: string) => { h.disk.delete(key); } };
  const account = getMobileAuthOwner().accountKey;
  let store = createDurableOutbox(storage); await store.activate(account);
  const replyId = '00000000-0000-4000-8000-000000000020';
  const shareId = '00000000-0000-4000-8000-000000000021';
  const bodies: unknown[] = [];
  let fail = true;
  const client = { personalList: { hidden: () => false }, syncListState: async () => {},
    members: async () => [], me: async () => self, actors: async () => [],
    send: vi.fn(async (_room, input, durable) => { await durable.save({ operationId: input.clientId, content: [], mentions: [] }); return { id: replyId }; }),
    shareToMain: vi.fn(async (_room, source, root, durable) => {
      expect(source).toBe(replyId); expect(root).toBe(self);
      const body = durable.body ?? { operationId: `thread-share:${source}`, content: [], mentions: [self] };
      if (!durable.body) await durable.save(body);
      bodies.push(body); if (fail) throw new Error('offline'); return { messageId: shareId, alreadyShared: false };
    }),
    load: async () => ({ snapshot: { room, members: [], messages: [], cursor: '1' }, messages: [], before: null }),
  } as any;
  const runner = () => createChatOutboxDelivery({ store, client, current: () => true, canRun: () => true, accessLost: async () => {} });
  await enqueueChatMessage(store, account, id, { clientId: 'topic-and-main', text: 'reply', threadRootId: self,
    mentions: { all: false, botIds: [] }, alsoSendToMain: true }, 0);
  await runner().run();
  expect(client.shareToMain).not.toHaveBeenCalled();
  await runner().run();
  await settleChatOutbox(store, id, new Set([replyId]));
  expect(store.getSnapshot()[0].chat).toMatchObject({ messageId: replyId, shareToMain: { state: 'failed' } });
  await enqueueChatMessage(store, account, id, { clientId: 'later-reply', text: 'later', threadRootId: self, mentions: { all: false, botIds: [] } }, 1);
  await runner().run();
  expect(client.send).toHaveBeenCalledTimes(2);
  store = createDurableOutbox(storage); await store.activate(account);
  const row = store.getSnapshot().find(row => row.item.clientId === 'topic-and-main')!;
  await store.update(row, { chat: { ...row.chat!, shareToMain: { ...row.chat!.shareToMain!, state: 'pending' } } });
  fail = false;
  await runner().run();
  expect(client.send).toHaveBeenCalledTimes(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(store.getSnapshot().find(row => row.item.clientId === 'topic-and-main')?.chat?.shareToMain)
    .toMatchObject({ state: 'sent', messageId: shareId });
});

// #7847 review, integration: a saved share receipt survives restart beyond the
// snapshot window. Retire it only after its canonical message reaches disk.
// r4420823552: unlike the known-ID case, a cross-device duplicate acknowledges the
// share with no ID. Keep its posted marker without repeatedly polling or sending.
it.each([false, true])('recovers an off-window share after restart without resending (already shared=%s)', async alreadyShared => {
  const storage = { getAllKeys: async () => [...h.disk.keys()], getItem: async (key: string) => h.disk.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.disk.set(key, value); }, removeItem: async (key: string) => { h.disk.delete(key); } };
  const account = getMobileAuthOwner().accountKey;
  let store = createDurableOutbox(storage); await store.activate(account);
  const replyId = '00000000-0000-4000-8000-000000000041', shareId = '00000000-0000-4000-8000-000000000042';
  const reply = { id: replyId, seq: '41', authorId: self, author: { kind: 'human', name: 'Me' },
    content: [{ type: 'text', text: alreadyShared ? 'Edited after desktop share' : 'Reply' }], createdAt: '2026-10-29', deleted: false, threadRootId: self };
  const shared = { ...reply, id: shareId, seq: '42', threadRootId: null, content: [{ type: 'card', namespace: 'cindy.thread-share', schemaRevision: 1,
    data: { messageId: replyId, threadRootId: self }, fallback: '' }] };
  await enqueueChatMessage(store, account, id, { clientId: 'confirmed-share', text: 'Reply', threadRootId: self,
    mentions: { all: false, botIds: [] }, alsoSendToMain: true }, 0);
  const row = store.getSnapshot()[0];
  await store.update(row, { state: 'confirming', enqueueStarted: true,
    chat: { ...row.chat!, messageId: replyId, shareToMain: alreadyShared ? { state: 'pending' } : { state: 'sent', messageId: shareId } } });
  store = createDurableOutbox(storage); await store.activate(account);
  const request = vi.fn(async (path: string, method?: string) => {
    if (method === 'POST') {
      if (alreadyShared) throw Object.assign(new Error('OPERATION_CONFLICT'), { code: 'OPERATION_CONFLICT', status: 409 });
      throw new Error('Must not resend');
    }
    if (path === '/me') return { actor: { id: self, kind: 'human' } };
    if (path.endsWith('/snapshot')) return { room, members: [], messages: [], cursor: '200' };
    if (path.includes('/messages?')) return [reply];
    if (path.endsWith(`/messages/${self}`)) return { ...reply, id: self, seq: '1', threadRootId: null };
    if (path.endsWith(`/messages/${replyId}`)) return reply;
    if (path.endsWith(`/messages/${shareId}`)) return shared;
    return [];
  });
  const client = createChatServerClient(request as any);
  const runner = () => createChatOutboxDelivery({ store, client, current: () => true, canRun: () => true, accessLost: async () => {} });
  h.historyWriteFails = !alreadyShared;
  await runner().run();
  expect(store.getSnapshot()).toHaveLength(1);
  expect(store.getSnapshot()[0].chat?.shareToMain).toMatchObject({ state: 'sent', messageId: alreadyShared ? null : shareId });
  const acknowledgedRequests = request.mock.calls.length;
  store = createDurableOutbox(storage); await store.activate(account);
  h.historyWriteFails = false;
  await runner().run();
  if (alreadyShared) {
    expect(store.getSnapshot()[0].chat?.shareToMain).toMatchObject({ state: 'sent', messageId: null });
    expect(request).toHaveBeenCalledTimes(acknowledgedRequests);
  } else expect(store.getSnapshot()).toEqual([]);
  const requests = request.mock.calls.length;
  await runner().run(); expect(request).toHaveBeenCalledTimes(requests);
  expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(alreadyShared ? 1 : 0);
  setMobileAuthOwner(null); peekChatMessages(id); setMobileAuthOwner('owner');
  const saved = (await readChatMessages(id, self))!.page;
  expect(alreadyShared ? saved.messages : saved.snapshot.messages).toContainEqual(alreadyShared ? reply : shared);
});

// The existing runner is the authority across account switches and crash windows.
// These are ordering/persistence regressions, not a parallel UI failure queue.
describe('two-stage topic delivery boundaries', () => {
  const reply = '00000000-0000-4000-8000-000000000031';
  const shared = '00000000-0000-4000-8000-000000000032';
  async function setup() {
    const storage = { getAllKeys: async () => [...h.disk.keys()], getItem: async (key: string) => h.disk.get(key) ?? null,
      setItem: async (key: string, value: string) => { h.disk.set(key, value); }, removeItem: async (key: string) => { h.disk.delete(key); } };
    const account = getMobileAuthOwner().accountKey;
    const store = createDurableOutbox(storage); await store.activate(account);
    const client = { personalList: { hidden: () => false }, syncListState: async () => {}, members: async () => [], me: async () => self, actors: async () => [],
      send: vi.fn(async (_room, input, durable) => { await durable.save(durable.body ?? { operationId: input.clientId, content: [], mentions: [] }); return { id: reply }; }),
      shareToMain: vi.fn(async (_room, _reply, _root, durable) => {
        await durable.save(durable.body ?? { operationId: `thread-share:${reply}`, content: [], mentions: [self] });
        return { messageId: shared, alreadyShared: false };
      }), load: async () => ({ snapshot: { room, members: [], messages: [], cursor: '1' }, messages: [], before: null }),
    } as any;
    const accessLost = vi.fn(async () => {});
    const runner = createChatOutboxDelivery({ store, client, current: () => true, canRun: () => true, accessLost });
    await enqueueChatMessage(store, account, id, { clientId: 'both', text: 'reply', threadRootId: self,
      mentions: { all: false, botIds: [] }, alsoSendToMain: true }, 0);
    return { storage, account, store, client, runner, accessLost };
  }
  it('never starts the share from an unknown reply outcome and coalesces duplicate wakeups', async () => {
    const { store, client, runner } = await setup();
    const send = client.send.getMockImplementation();
    client.send.mockImplementationOnce(async (...args: unknown[]) => { await send(...args); throw new Error('lost response'); });
    await Promise.all([runner.run(), runner.run()]);
    expect(client.send).toHaveBeenCalledTimes(1); expect(client.shareToMain).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0].chat?.messageId).toBeUndefined();
    await runner.run(); await Promise.all([runner.run(), runner.run()]);
    expect(client.send).toHaveBeenCalledTimes(2); expect(client.shareToMain).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[1][2].body).toEqual(client.send.mock.calls[0][2].body ?? { operationId: 'both', content: [], mentions: [] });
  });
  it('recovers the persisted post body after a process stops before its receipt, and settles only once represented', async () => {
    const { storage, account, store, client, runner } = await setup();
    await runner.run();
    const row = store.getSnapshot()[0];
    const body = { operationId: `thread-share:${reply}`, content: [], mentions: [self] };
    await store.update(row, { chat: { ...row.chat!, shareToMain: { state: 'pending', body } } });
    const restored = createDurableOutbox(storage); await restored.activate(account);
    const resumed = createChatOutboxDelivery({ store: restored, client, current: () => true, canRun: () => true, accessLost: async () => {} });
    await resumed.run();
    expect(client.send).toHaveBeenCalledTimes(1); expect(client.shareToMain.mock.calls[0][3].body).toEqual(body);
    const { settleChatOutbox } = await import('@/chat/chatOutbox');
    await settleChatOutbox(restored, id, new Set([reply])); expect(restored.getSnapshot()).toHaveLength(1);
    await settleChatOutbox(restored, id, new Set([reply]), new Set([reply])); expect(restored.getSnapshot()).toHaveLength(0);
  });
  it('does not adopt a late share receipt into another account', async () => {
    const { store, client, runner } = await setup(); await runner.run();
    client.shareToMain.mockImplementationOnce(async (_room: string, _reply: string, _root: string, durable: any) => {
      await durable.save({ operationId: `thread-share:${reply}`, content: [], mentions: [self] });
      await store.activate('global:other'); return { messageId: shared, alreadyShared: false };
    });
    await runner.run(); expect(store.getSnapshot()).toEqual([]);
    await runner.run(); expect(client.shareToMain).toHaveBeenCalledTimes(1);
  });
  // #7847 review, integration: a deleted off-window share must not revoke the room
  // or stop the next draft; an actual room rejection must still suspend both.
  it.each(['MESSAGE_NOT_FOUND', 'CONVERSATION_NOT_FOUND'])('scopes a share receipt lookup rejection: %s', async code => {
    const { store, client, runner, accessLost } = await setup();
    await runner.run();
    const row = store.getSnapshot()[0];
    await store.update(row, { chat: { ...row.chat!, shareToMain: { state: 'sent', messageId: shared } } });
    client.message = vi.fn(async () => { throw Object.assign(new Error(code), { status: 404, code }); });
    await enqueueChatMessage(store, store.getAccountId(), id, { clientId: 'next-draft', text: 'Next',
      mentions: { all: false, botIds: [] } }, 0);
    await runner.run();
    if (code === 'MESSAGE_NOT_FOUND') {
      expect(accessLost).not.toHaveBeenCalled();
      expect(store.getSnapshot()[0].chat?.shareToMain).toMatchObject({ state: 'unavailable', messageId: shared });
      expect(store.getSnapshot().some(record => record.suspended)).toBe(false);
      expect(client.send).toHaveBeenCalledTimes(2);
      expect(peekChatMessages(id)).not.toBeNull();
      await runner.run();
      expect(client.message).toHaveBeenCalledTimes(1);
      expect(client.shareToMain).not.toHaveBeenCalled();
    } else {
      expect(accessLost).toHaveBeenCalledWith(id);
      expect(store.getSnapshot().every(record => record.suspended)).toBe(true);
      expect(client.send).toHaveBeenCalledTimes(1);
    }
  });
  it.each([false, true])('keeps source unavailability local but permanently stops room revocation (room=%s)', async roomLost => {
    const { store, client, runner, accessLost } = await setup(); await runner.run();
    client.shareToMain.mockRejectedValue(roomLost ? Object.assign(new Error('CONVERSATION_NOT_FOUND'), { status: 403 }) : new Error('SHARE_UNAVAILABLE'));
    await runner.run(); const row = store.getSnapshot()[0];
    if (roomLost) { expect(row.suspended).toBe(true); expect(accessLost).toHaveBeenCalledWith(id); }
    else { expect(row.chat?.shareToMain?.state).toBe('unavailable'); expect(accessLost).not.toHaveBeenCalled(); }
    await runner.run(); expect(client.shareToMain).toHaveBeenCalledTimes(1);
    if (roomLost) {
      await enqueueChatMessage(store, store.getAccountId(), id, { clientId: 'after-rejoin', text: 'Explicit new reply', threadRootId: self,
        mentions: { all: false, botIds: [] } }, 0);
      await runner.run(); expect(client.send).toHaveBeenCalledTimes(2); expect(client.shareToMain).toHaveBeenCalledTimes(1);
    }
  });
});
