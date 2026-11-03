// Unit tier: real files cover restart/owner boundaries absent from transport mocks.
// Minimal failure: save one unacknowledged send, recreate the service, then retry it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', owner: { dataOwnerId: 'a', generation: 1 }, pin: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(state.root, state.owner.dataOwnerId, ...parts),
  getActiveAppSession: () => state.owner, isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.example' }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../cindy-media/blobStore.js', () => ({ parseBlobUrl: (url: string) => url === 'cindy-media://blob/held.png' ? { hash: 'held' } : null }));
vi.mock('../../cindy-media/ledger.js', () => ({ hasRef: async () => false, pinBlob: state.pin, addRef: state.add,
  removeRefById: state.remove, removeRefs: state.remove }));
import { chatSendJournal } from '../chatSendJournal.js';
import { accessBotGroupOutbox } from '../botGroupOutboxStorage.js';
import { accessChatDisplayCache } from '../chatDisplayCache.js';
import { extractIpcError } from '../../../shared/ipcError.js';

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-persistence-'));
  state.owner = { dataOwnerId: 'a', generation: 1 };
  state.pin.mockReset().mockResolvedValue(undefined); state.add.mockReset().mockResolvedValue('ref'); state.remove.mockReset().mockResolvedValue(1);
});
afterEach(() => rmSync(state.root, { recursive: true, force: true }));

it('restores display snapshots, removes them durably and rejects late writes from another login', () => {
  const owner = state.owner;
  const value = { messages: [{ id: 'saved-message', text: 'saved' }] };
  accessChatDisplayCache({ action: 'write', key: 'companion:bot', owner, value });
  expect(accessChatDisplayCache({ action: 'read', key: 'companion:bot', owner })).toEqual(value);
  accessChatDisplayCache({ action: 'remove', key: 'companion:bot', owner });
  expect(accessChatDisplayCache({ action: 'read', key: 'companion:bot', owner })).toBeNull();
  state.owner = { dataOwnerId: 'b', generation: 2 };
  expect(() => accessChatDisplayCache({ action: 'write', key: 'groups', owner, value })).toThrow('OWNER_CHANGED');
  expect(accessChatDisplayCache({ action: 'read', key: 'groups', owner: state.owner })).toBeNull();
});

it('replays the frozen intent after restart, compacts its receipt and fences another owner', () => {
  const owner = state.owner;
  const current = () => state.owner === owner;
  const journal = chatSendJournal('https://chat.example', current);
  const intent = { route: '/conversations/room/messages', body: { operationId: 'client-a', mentions: ['original-recipient'], content: [{ type: 'text', text: 'saved' }] } };
  journal.save('send', 'signature', intent);
  const restarted = chatSendJournal('https://chat.example', current);
  expect(restarted.read('send', 'signature')).toMatchObject({ intent });
  expect(() => restarted.read('send', 'changed')).toThrow('INVALID_INPUT');
  restarted.confirm('send', 'signature', 'server-message');
  expect(chatSendJournal('https://chat.example', current).read('send', 'signature')).toMatchObject({ receipt: 'server-message' });
  state.owner = { dataOwnerId: 'b', generation: 2 };
  expect(() => restarted.save('late', 'signature', intent)).toThrow('OWNER_CHANGED');
  expect(chatSendJournal('https://chat.example', () => true).read('send', 'signature')).toBeNull();
});

it('restores independent queued messages and holds media until a durable removal', async () => {
  const owner = state.owner;
  const entry = { input: { groupId: 'room', clientId: 'client-a', text: 'saved', mentions: { all: false, botIds: [] } }, createdAt: 1,
    draft: 'saved', signature: 'saved', attachmentScope: 'room', after: 0, tracked: [], attachments: [],
    status: 'sending' as const, files: [{ url: 'cindy-media://blob/held.png' }] };
  await accessBotGroupOutbox({ action: 'put', owner, entry });
  await accessBotGroupOutbox({ action: 'put', owner, entry: { ...entry, input: { ...entry.input, clientId: 'client-b' }, files: [] } });
  expect(state.pin).toHaveBeenCalledWith('held', expect.anything());
  expect(await accessBotGroupOutbox({ action: 'list', owner })).toHaveLength(2);
  await accessBotGroupOutbox({ action: 'remove', owner, groupId: 'room', clientId: 'client-a' });
  expect((await accessBotGroupOutbox({ action: 'list', owner })).map(row => row.input.clientId)).toEqual(['client-b']);
  expect(state.remove).toHaveBeenCalled();
  state.owner = { dataOwnerId: 'b', generation: 2 };
  await expect(accessBotGroupOutbox({ action: 'put', owner, entry })).rejects.toThrow('OUTBOX_OWNER_CHANGED');
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner })).toEqual([]);
});

// PR #8146: nested mention validation used to strip allBots on both put and list.
// Existing persistence cases only stored ordinary sends. Unit tier with real atomic files:
// one companion broadcast must restore byte-equivalent input for the same receipt retry.
it('restores a companion broadcast unchanged for a lost-receipt retry', async () => {
  const owner = state.owner;
  const input = { groupId: 'room', clientId: 'broadcast-a', text: '@All teammates hello',
    mentions: { all: false, allBots: true, botIds: [] } };
  const entry = { input, createdAt: 1, draft: input.text, signature: 'broadcast-signature',
    attachmentScope: 'room', after: 0, tracked: [], attachments: [], status: 'sending' as const, files: [] };
  await accessBotGroupOutbox({ action: 'put', owner, entry });
  const journal = chatSendJournal<{ input: typeof input }>('https://chat.example', () => state.owner === owner);
  journal.save(input.clientId, entry.signature, { input });
  // Only the restored disk record supplies the retry, as after a window/app restart.
  const [restored] = await accessBotGroupOutbox({ action: 'list', owner });
  expect(restored!.input).toEqual(input);
  const restarted = chatSendJournal<{ input: typeof input }>('https://chat.example', () => state.owner === owner);
  expect(restarted.read(restored!.input.clientId, restored!.signature as string)?.intent?.input).toEqual(restored!.input);
  restarted.confirm(restored!.input.clientId, restored!.signature as string, 'broadcast-receipt');
  expect(chatSendJournal('https://chat.example', () => state.owner === owner)
    .read(restored!.input.clientId, restored!.signature as string)).toMatchObject({ receipt: 'broadcast-receipt' });
});

// Unit / PR #8637: main reload or same-account generation repair must not steal
// a live secondary's editable failure. Crash/navigation/destruction releases it.
it.each(['render-process-gone', 'destroyed', 'did-navigate'])('restores only orphaned sends after %s', async event => {
  const secondary = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const main = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const sender = (value: typeof main) => value as unknown as WebContents;
  const entry = { input: { groupId: 'room', clientId: 'owned', text: 'editable', mentions: { all: false, botIds: [] } }, createdAt: 1,
    draft: 'editable', signature: 'owned', attachmentScope: 'room', after: 0, tracked: [], attachments: [], status: 'failed' as const, files: [] };
  await accessBotGroupOutbox({ action: 'put', owner: state.owner, entry }, sender(secondary));
  state.owner = { ...state.owner, generation: 2 };
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(main))).toEqual([]);
  // review4457346624: both mutations retain a decodable error after Electron
  // strips Error.code. Contention must not look like an unknown storage failure.
  for (const request of [
    { action: 'put', owner: state.owner, entry },
    { action: 'remove', owner: state.owner, groupId: 'room', clientId: 'owned' },
  ]) {
    const error: unknown = await accessBotGroupOutbox(request, sender(main)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    const transported = new Error(`Error invoking remote method 'botGroup:outbox': Error: ${(error as Error).message}`);
    expect.soft(extractIpcError(transported)).toEqual({ code: 'PRECONDITION_FAILED', message: 'OUTBOX_ENTRY_OWNED' });
  }
  await accessBotGroupOutbox({ action: 'remove', owner: state.owner, groupId: 'room', clientId: 'owned' }, sender(secondary));
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(main))).toEqual([]);
  await accessBotGroupOutbox({ action: 'put', owner: state.owner, entry }, sender(secondary));
  // In-page navigation cannot relinquish a still-live composer's queue.
  secondary.emit('did-start-navigation', {}, 'app://cindy', true, true);
  secondary.emit('did-start-navigation', {}, 'app://cindy', false, true);
  secondary.emit('did-navigate-in-page');
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(main))).toEqual([]);
  secondary.emit(event);
  const restored = await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(main));
  expect(restored.map(row => row.input.clientId)).toEqual(['owned']);
  const another = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(another))).toEqual([]);
  await accessBotGroupOutbox({ action: 'remove', owner: state.owner, groupId: 'room', clientId: 'owned' }, sender(main));
  expect(await accessBotGroupOutbox({ action: 'list', owner: state.owner }, sender(main))).toEqual([]);
});

// A renderer can die while an accepted put/remove waits behind media pinning.
// A recovery list may already be queued before the remove enters. It must not
// claim the row and reject the edit after the original renderer dies. Unit tier.
it.each(['before', 'after'])('finishes accepted mutations when recovery is queued %s removal and the renderer crashes', async order => {
  const secondary = new EventEmitter() as unknown as WebContents;
  const main = new EventEmitter() as unknown as WebContents;
  let pinned!: () => void;
  let entered!: () => void;
  const pin = new Promise<void>(resolve => { pinned = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  state.pin.mockImplementation(() => { entered(); return pin; });
  const entry = { input: { groupId: 'room', clientId: 'edited-before-crash', text: 'old', mentions: { all: false, botIds: [] } }, createdAt: 1,
    draft: 'old', signature: 'old', attachmentScope: 'room', after: 0, tracked: [], attachments: [], status: 'failed' as const,
    files: [{ url: 'cindy-media://blob/held.png' }] };
  const put = accessBotGroupOutbox({ action: 'put', owner: state.owner, entry }, secondary);
  await started;
  const earlyList = order === 'before' ? accessBotGroupOutbox({ action: 'list', owner: state.owner }, main) : null;
  const remove = accessBotGroupOutbox({ action: 'remove', owner: state.owner, groupId: 'room', clientId: entry.input.clientId }, secondary);
  secondary.emit('render-process-gone');
  const restored = earlyList ?? accessBotGroupOutbox({ action: 'list', owner: state.owner }, main);
  pinned();
  try {
    await put;
    await remove;
    expect(await restored).toEqual([]);
    // A completed mutation must not leave a reservation that hides future rows.
    await accessBotGroupOutbox({ action: 'put', owner: state.owner, entry });
    expect((await accessBotGroupOutbox({ action: 'list', owner: state.owner }, main)).map(row => row.input.clientId)).toEqual([entry.input.clientId]);
    await accessBotGroupOutbox({ action: 'remove', owner: state.owner, groupId: 'room', clientId: entry.input.clientId }, main);
  } finally {
    main.emit('destroyed');
  }
});
