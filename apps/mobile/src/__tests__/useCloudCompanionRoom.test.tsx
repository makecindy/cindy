// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ owner: 'owner:1:global', current: true, companionRoom: vi.fn(), history: vi.fn(), media: vi.fn(), disk: new Map<string, string>(), appStateListeners: new Set<(state: string) => void>() }));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (key: string) => h.disk.get(key) ?? null,
  write: async (key: string, value: string) => { h.disk.set(key, value); },
  remove: async (key: string) => { h.disk.delete(key); }, files: async () => [...h.disk.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_event: string, listener: (state: string) => void) => {
  h.appStateListeners.add(listener);
  return { remove() { h.appStateListeners.delete(listener); } };
} } }));
vi.mock('expo-crypto', () => ({ digestStringAsync: vi.fn(async () => 'hash'), CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, CryptoEncoding: { HEX: 'hex' } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
vi.mock('@/chat/useChatServer', async () => {
  const { useMemo } = await import('react');
  return { useChatClient: () => useMemo(() => ({ owner: h.owner, enabled: true, current: () => h.current,
    client: { companionRoom: h.companionRoom, history: h.history, media: h.media } }), [h.owner]) };
});
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { peekCloudConversation } from '@/chat/cloudConversationCache';
import { useCloudCompanionRoom } from '@/chat/useCloudCompanionRoom';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ROOM = '00000000-0000-4000-8000-0000000000aa';
const MEDIA = '00000000-0000-4000-8000-0000000000bb';
let root: Root;
let result: ReturnType<typeof useCloudCompanionRoom>;
function Probe() { result = useCloudCompanionRoom('actor', 'Writer', true); return null; }
const render = () => act(async () => root.render(createElement(Probe)));
beforeEach(async () => {
  setMobileAuthOwner(null); peekCloudConversation('actor'); await clearHistoryDisk(); setMobileAuthOwner('owner');
  vi.resetAllMocks(); h.owner = 'owner:1:global'; h.current = true; h.appStateListeners.clear();
  h.companionRoom.mockResolvedValue(ROOM); h.history.mockResolvedValue({ messages: [], before: null });
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

// Tier: behavior. An attachment address is signed per room, so it must be asked of the room this
// hook resolved, and an answer that arrives after the account changed must not be shown.
it('fetches an attachment address from the 1:1 room and drops it when the account changed meanwhile', async () => {
  const file = { id: MEDIA, name: 'report.docx', mimeType: 'application/msword', size: 3, category: 'file', url: 'https://files.example/r', path: null };
  h.media.mockResolvedValue(file);
  await render();
  await expect(result.media(MEDIA)).resolves.toBe(file);
  expect(h.media).toHaveBeenCalledWith(ROOM, MEDIA);
  let complete!: (value: unknown) => void;
  h.media.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const late = result.media(MEDIA);
  h.current = false;
  complete(file);
  await expect(late).rejects.toThrow('OWNER_CHANGED');
});

it('has no address to fetch before the room is known', async () => {
  h.companionRoom.mockReturnValue(new Promise(() => {}));
  await render();
  await expect(result.media(MEDIA)).rejects.toThrow('OWNER_CHANGED');
  expect(h.media).not.toHaveBeenCalled();
});

// Unit tier: older 1:1 pages must consume server corrections and disappear after a history reset.
it('updates old messages outside the latest private-chat page and drops them on a history reset', async () => {
  const message = (id: string, deleted = false) => ({ id, seq: id, deleted, content: [{ type: 'text', text: id }] });
  h.history.mockResolvedValueOnce({ messages: [message('2')], before: '2', historyRevision: 'A' });
  await render();
  h.history.mockResolvedValueOnce({ messages: [message('1')], before: null, historyRevision: 'A' });
  await act(async () => { await result.loadOlder(); });
  h.history.mockResolvedValueOnce({ messages: [message('3')], before: '3', historyRevision: 'A',
    messageUpdates: [{ ...message('2'), content: [{ type: 'text', text: 'edited' }] }, message('1', true)] });
  await act(async () => { await result.reload(); });
  expect(result.messages.map(value => [value.id, value.deleted, value.content[0]?.text])).toEqual([
    ['3', false, '3'], ['2', false, 'edited'], ['1', true, '1'],
  ]);
  h.history.mockResolvedValueOnce({ messages: [message('3')], before: null, historyRevision: 'B' });
  await act(async () => { await result.reload(); });
  expect(result.messages.map(value => value.id)).toEqual(['3']);
});

// PR #7242, unit: the existing refresh test had already loaded an older page.
// A full first page shifts without changing length when one new message arrives.
it('keeps the displaced oldest message when a full private-chat page refreshes', async () => {
  const message = (seq: number) => ({ id: String(seq), seq: String(seq), content: [{ type: 'text', text: String(seq) }] });
  h.history.mockResolvedValueOnce({ messages: Array.from({ length: 100 }, (_, i) => message(100 - i)), before: '1', historyRevision: 'A' });
  await render();
  h.history.mockResolvedValueOnce({ messages: Array.from({ length: 100 }, (_, i) => message(101 - i)), before: '2', historyRevision: 'A',
    messageUpdates: [{ ...message(1), content: [{ type: 'text', text: 'edited' }] }] });
  await act(async () => { await result.reload(); });
  expect(result.messages.map(value => value.id)).toEqual(Array.from({ length: 101 }, (_, i) => String(101 - i)));
  expect(result.messages.at(-1)?.content[0]?.text).toBe('edited');
  expect(result.before).toBe('1');
  expect(peekCloudConversation('actor')?.messages).toEqual(result.messages);
  expect(h.history).toHaveBeenCalledTimes(2);
});

it('ignores a delayed older private-chat page after the displayed history was reset', async () => {
  h.history.mockResolvedValueOnce({ messages: [{ id: 'new' }], before: '2', historyRevision: 'A' });
  await render();
  let finish!: (value: unknown) => void;
  h.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let older!: Promise<void>;
  await act(async () => { older = result.loadOlder(); });
  h.history.mockResolvedValueOnce({ messages: [{ id: 'allowed' }], before: null, historyRevision: 'B' });
  await act(async () => { await result.reload(); });
  await act(async () => { finish({ messages: [{ id: 'no-longer-visible' }], before: null, historyRevision: 'A' }); await older; });
  expect(result.messages.map(value => value.id)).toEqual(['allowed']);
});

// Unit tier: a foreground refresh invalidates pagination responses, but a failed refresh must
// still let the user retry pagination when that stale request settles (success or failure).
it.each(['success', 'failure'] as const)('releases stale pagination after a failed foreground refresh and older-page %s', async outcome => {
  h.history.mockResolvedValueOnce({ messages: [{ id: 'new' }], before: '2', historyRevision: 'A' });
  await render();
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  h.history.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  let older!: Promise<void>;
  await act(async () => { older = result.loadOlder(); });
  expect(result.loadingOlder).toBe(true);
  h.history.mockRejectedValueOnce(new Error('NETWORK_ERROR'));
  await act(async () => { h.appStateListeners.forEach(listener => listener('active')); });
  await act(async () => {
    if (outcome === 'success') finish({ messages: [{ id: 'stale' }], before: null, historyRevision: 'A' });
    else fail(new Error('NETWORK_ERROR'));
    await older;
  });
  expect(result.loadingOlder).toBe(false);
  expect(result.status).toBe('ready');
  expect(result.messages.map(message => message.id)).toEqual(['new']);
  expect(result.before).toBe('2');
  h.history.mockResolvedValueOnce({ messages: [{ id: 'older' }], before: null, historyRevision: 'A' });
  await act(async () => { await result.loadOlder(); });
  expect(result.messages.map(message => message.id)).toEqual(['new', 'older']);
  expect(result.before).toBeNull();
});

// Integration: the cloud-only route must hydrate before resolving the companion room.
// Existing coverage tested signed attachment access but never reopened this route offline.
it('restores a saved cloud transcript across remount and process-cache loss, then purges revoked access', async () => {
  const message = { id: 'message', seq: '1', authorId: 'actor', author: { name: 'Writer', kind: 'bot' }, content: [{ type: 'text', text: 'Saved reply' }] };
  h.history.mockResolvedValue({ messages: [message], before: null });
  await render(); expect(result.messages).toEqual([message]);
  await act(async () => root.unmount());
  setMobileAuthOwner(null); peekCloudConversation('actor'); setMobileAuthOwner('owner');
  h.companionRoom.mockImplementation(() => new Promise(() => {}));
  root = createRoot(document.createElement('div')); await render();
  expect(result.status).toBe('ready'); expect(result.messages).toEqual([message]);
  h.history.mockRejectedValue({ status: 403 });
  await act(async () => result.reload());
  expect(result.messages).toEqual([]); expect(peekCloudConversation('actor')).toBeNull();
});
