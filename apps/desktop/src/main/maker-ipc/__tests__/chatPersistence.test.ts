// Unit tier: real files cover restart/owner boundaries absent from transport mocks.
// Minimal failure: save one unacknowledged send, recreate the service, then retry it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
