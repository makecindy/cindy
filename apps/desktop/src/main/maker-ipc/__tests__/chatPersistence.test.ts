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
  onAppSessionInvalidated: () => () => {},
}));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.example' }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../cindy-media/blobStore.desktop.js', () => ({ parseBlobUrl: (url: string) => url === 'cindy-media://blob/held.png' ? { hash: 'held' } : null }));
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

// #9760 / #8350, unit tier: real shared display-cache file. Prior tests only
// covered one writer. A stale window must not undo a newer window's deletion.
it('keeps cloud tombstones even when a stale window still lists the removed actor', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  const value = { enabled: true, actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value });
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { enabled: true, actors: [{ externalId: 'mia' }], retiredBotIds: [] } });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).toMatchObject({ retiredBotIds: ['mia'] });
});

// A real active actor after retirement can restore the same identity; a stored
// revival is one-shot metadata and must not be replayed on the next window read.
it('revives a known retired identity explicitly and keeps account caches separate', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  const retired = accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: { actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision } }) as { retirementRevision: number };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [{ externalId: 'mia' }], retiredBotIds: [], revivedBotIds: ['mia'], retirementRevision: retired.retirementRevision } });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).toMatchObject({ actors: [{ externalId: 'mia' }], retiredBotIds: [] });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).not.toHaveProperty('revivedBotIds');
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).not.toHaveProperty('newlyRetiredBotIds');
  state.owner = { dataOwnerId: 'b', generation: 2 };
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner: state.owner })).toEqual({ retirementRevision: expect.any(Number) });
  expect(() => accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: {} })).toThrow('OWNER_CHANGED');
});

// A revival prepared before a newer retirement must not erase that deletion.
it.each(['after revival', 'while retired'])('rejects a stale revival after a newer deletion (%s)', phase => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  const retired = accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: { actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision } }) as { retirementRevision: number };
  const revival = { actors: [{ externalId: 'mia' }], retiredBotIds: [], revivedBotIds: ['mia'], retirementRevision: retired.retirementRevision };
  if (phase === 'after revival') accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: revival });
  const current = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: { actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: current.retirementRevision } });
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: revival });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).toMatchObject({ retiredBotIds: ['mia'] });
});

// #9760 review F1: rejected writes cross IPC; callers must receive typed errors
// while failed writes leave the authoritative deletion intact.
it('encodes unhydrated and invalid cloud cache writes without losing tombstones', () => {
  const owner = state.owner;
  const write = (value: unknown) => accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value });
  const errorCode = (value: unknown) => {
    try { write(value); } catch (error) {
      // Electron forwards the message without custom Error properties.
      const forwarded = new Error(`Error invoking remote method: Error: ${(error as Error).message}`);
      return extractIpcError(forwarded)?.code;
    }
    return null;
  };
  expect(errorCode({ actors: [] })).toBe('PRECONDITION_FAILED');
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  write({ actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision });
  expect(errorCode([])).toBe('INVALID_PARAMS');
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner })).toMatchObject({ retiredBotIds: ['mia'] });
});

// #11303 review: a dormant window's saved retirement is history, not a new deletion.
// Unit tier, real shared cache: retire -> revive in A -> B writes its old snapshot.
it('keeps a revived identity and its roster when another window writes retirement history', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  const retired = accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision } }) as { retirementRevision: number };
  const dormant = { actors: [], retiredBotIds: ['mia'], newlyRetiredBotIds: [], retirementRevision: retired.retirementRevision };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [{ externalId: 'mia' }], retiredBotIds: [], revivedBotIds: ['mia'], retirementRevision: retired.retirementRevision } });
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: dormant });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }))
    .toMatchObject({ actors: [{ externalId: 'mia' }], retiredBotIds: [] });
});

// Empty hydration still supplies the fence: consecutive normal updates may be
// sent before the first write receipt reaches the renderer.
it('persists the latest ordinary roster after empty-cache hydration', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  expect(hydrated.retirementRevision).toEqual(expect.any(Number));
  for (const name of ['Mia', 'Mia updated']) accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [{ externalId: 'mia', name }], newlyRetiredBotIds: [], retirementRevision: hydrated.retirementRevision } });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }))
    .toMatchObject({ actors: [{ externalId: 'mia', name: 'Mia updated' }], retiredBotIds: [] });
});

// Deletion and the next authoritative roster can be sent before Main's first
// receipt arrives. A stale fence must retain new identities without reviving old ones.
it('keeps a newly accepted actor while the preceding deletion receipt is pending', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [], newlyRetiredBotIds: ['mia', 'ada'], retirementRevision: hydrated.retirementRevision } });
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [{ externalId: 'bob' }, { externalId: 'ada' }], newlyRetiredBotIds: [], retirementRevision: hydrated.retirementRevision } });
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }))
    .toMatchObject({ actors: [{ externalId: 'bob' }], retiredBotIds: ['mia', 'ada'] });
});

// Two windows can derive the same removal before either receives Main's receipt.
// A delayed duplicate must not retire an identity revived after that observation.
it('rejects a delayed deletion derived before another window revived the identity', () => {
  const owner = state.owner;
  const hydrated = accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }) as { retirementRevision: number };
  const deletion = { actors: [], newlyRetiredBotIds: ['mia'], retirementRevision: hydrated.retirementRevision };
  const retired = accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: deletion }) as { retirementRevision: number };
  accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner,
    value: { actors: [{ externalId: 'mia' }], revivedBotIds: ['mia'], retirementRevision: retired.retirementRevision } });
  expect(() => accessChatDisplayCache({ action: 'write', key: 'cloud-homes', owner, value: deletion }))
    .toThrow('PRECONDITION_FAILED');
  expect(accessChatDisplayCache({ action: 'read', key: 'cloud-homes', owner }))
    .toMatchObject({ actors: [{ externalId: 'mia' }], retiredBotIds: [] });
});
