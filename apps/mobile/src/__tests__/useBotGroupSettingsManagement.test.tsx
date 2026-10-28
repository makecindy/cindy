// @vitest-environment jsdom
// Regression: cloud group settings used to require an online computer. Unit tier exercises
// the production hook + HTTP client with no device-link provider, including account fences,
// server role revocation, edit conflicts and uncertain write receipts. Existing tests covered hosts only.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chatGroupView, createChatServerClient, type ChatSnapshot } from '@/chat/chatServerClient';
const h = vi.hoisted(() => ({ api: null as any, enabled: true, uuid: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `operation-${++h.uuid}` }));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => h.api }));
import { useBotGroupSettingsManagement, useCloudGroupCandidates } from '@/session/useBotGroupSettingsManagement';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let snapshot: ChatSnapshot;
let root: Root | undefined;
let result: ReturnType<typeof useBotGroupSettingsManagement>;
let candidates: ReturnType<typeof useCloudGroupCandidates>;
let source: ReturnType<typeof chatGroupView>;
const request = vi.fn();
const writes = () => request.mock.calls.filter(call => call[1] === 'POST' || call[1] === 'PATCH');
function Probe() { result = useBotGroupSettingsManagement(source, h.enabled); candidates = useCloudGroupCandidates(h.enabled); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
function api(owner = 'account-1') {
  return { owner, enabled: true, current: () => h.api.owner === owner, client: createChatServerClient(request) };
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true; h.uuid = 0;
  snapshot = { room: { id: id(1), name: 'Group', description: 'Original', kind: 'group', archived: false, revision: 4,
    response_mode: 'all', speaking_mode: 'auto', created_at: '2026-10-01', updated_at: '2026-10-01' }, cursor: '1', messages: [], members: [
    { id: id(2), kind: 'human', ownerActorId: id(2), ownerName: '', name: 'Me', avatar: null, state: 'joined', role: 'owner' },
    { id: id(3), kind: 'bot', ownerActorId: id(2), ownerName: '', name: 'Bot', avatar: null, state: 'joined', role: 'member' },
  ] };
  source = chatGroupView({ snapshot, messages: [], before: null }, id(2));
  request.mockImplementation(async (path, method, body) => {
    if (path === '/me') return { actor: { id: id(2), kind: 'human' }, capabilities: { groupSingleSpeaker: 1 } };
    if (path === '/actors') return [{ id: id(4), kind: 'bot', externalId: 'offline-bot', name: 'Offline bot', avatar: null, homeDeviceId: null }];
    if (path.endsWith('/snapshot')) return structuredClone(snapshot);
    if (method === 'PATCH') {
      if (!['owner', 'admin'].includes(snapshot.members[0].role)) throw Object.assign(new Error('ROLE_REQUIRED'), { status: 403 });
      if (body.expectedRevision !== snapshot.room.revision) throw Object.assign(new Error('REVISION_CONFLICT'), { status: 409 });
      if (body.name !== undefined) snapshot.room.name = body.name;
      if (body.description !== undefined) snapshot.room.description = body.description;
      snapshot.room.revision++;
      return { revision: snapshot.room.revision };
    }
    if (method === 'POST') return { state: 'joined' };
    throw new Error(`Unexpected ${path}`);
  });
  h.api = api();
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('reads and saves cloud settings and offers offline companions without any host connection', async () => {
  await render();
  expect(result.editable).toBe(true);
  expect(result.group).toMatchObject({ description: 'Original', singleSpeaker: true });
  expect(candidates.rows.map(row => row.id)).toEqual([id(4)]);
  await act(async () => { await result.act('update', { name: 'Renamed', description: 'Shared background', replyMode: 'mentioned', organizerBotId: id(3) }); });
  expect(writes()[0]).toEqual([`/conversations/${id(1)}`, 'PATCH', { operationId: 'operation-1', expectedRevision: 4, name: 'Renamed', description: 'Shared background', responseMode: 'mentioned', organizerId: id(3) }, id(2)]);
  expect(result.group).toMatchObject({ name: 'Renamed', description: 'Shared background', revision: 5 });
  await act(async () => { await result.act('add-member', { botId: id(4) }); await result.act('set-member-role', { actorId: id(3), role: 'admin' }); await result.act('remove-member', { actorId: id(3) }); });
  expect(writes().slice(1).map(call => call[2])).toEqual([
    { operationId: 'operation-2', actorId: id(4), action: 'invite' },
    { operationId: 'operation-3', actorId: id(3), action: 'role', role: 'admin' },
    { operationId: 'operation-4', actorId: id(3), action: 'remove' },
  ]);
});

it.each(['member', 'guest'] as const)('keeps %s read-only based on account membership', async role => {
  snapshot.members[0].role = role; await render();
  expect(result.reason).toBe('permission');
  await expect(result.act('update', { name: 'Denied' })).rejects.toThrow('PERMISSION_DENIED');
  expect(writes()).toHaveLength(0);
});

it('selects only an owned manager, never a foreign owner', async () => {
  snapshot.members[0].role = 'member'; snapshot.members[1].role = 'admin';
  snapshot.members.push({ ...snapshot.members[0], id: id(9), ownerActorId: id(9), role: 'owner' });
  await render(); await act(async () => { await result.act('add-member', { botId: id(4) }); });
  expect(writes()[0][3]).toBe(id(3));
});

it('reloads revoked roles after a rejected write without reporting it saved', async () => {
  await render(); snapshot.members[0].role = 'member';
  await act(async () => { await expect(result.act('update', { name: 'Denied' })).rejects.toThrow('ROLE_REQUIRED'); });
  expect(result.editable).toBe(false); expect(result.reason).toBe('permission');
  expect(result.group?.name).toBe('Group');
});

it('preserves the edit revision and returns conflicts instead of overwriting a newer value', async () => {
  await render(); snapshot.room.revision = 5; snapshot.room.name = 'Other edit';
  await act(async () => { await expect(result.act('update', { name: 'My draft', expectedRevision: 4 })).rejects.toThrow('REVISION_CONFLICT'); });
  expect(result.group).toMatchObject({ revision: 5, name: 'Other edit' });
  await act(async () => { await result.act('update', { name: 'Reviewed draft', expectedRevision: 5 }); });
  expect(writes()[1][2].operationId).not.toBe(writes()[0][2].operationId);
});

it('reuses the operation receipt on an explicit retry after an uncertain network result', async () => {
  await render(); const original = request.getMockImplementation()!; let fail = true;
  request.mockImplementation(async (...args) => { if (args[1] === 'POST' && fail) { fail = false; throw new Error('Network lost'); } return original(...args); });
  await act(async () => { await expect(result.act('add-member', { botId: id(4) })).rejects.toThrow('Network lost'); });
  await act(async () => { await result.act('add-member', { botId: id(4) }); });
  expect(writes()).toHaveLength(2); expect(writes()[0]).toEqual(writes()[1]);
});

it('replays the original write after a lost acknowledgement advances the readback revision', async () => {
  await render(); const original = request.getMockImplementation()!;
  let receipt: unknown;
  request.mockImplementation(async (...args) => {
    if (args[1] !== 'PATCH') return original(...args);
    if (receipt) return receipt;
    receipt = await original(...args);
    throw new Error('Acknowledgement lost');
  });
  await act(async () => { await expect(result.act('update', { description: 'Saved once', expectedRevision: 4 })).rejects.toThrow('Acknowledgement lost'); });
  expect(result.group?.revision).toBe(5);
  await act(async () => { await result.act('update', { description: 'Saved once', expectedRevision: 5 }); });
  expect(writes()).toHaveLength(2); expect(writes()[0]).toEqual(writes()[1]);
  expect(result.group?.revision).toBe(5);
});

it('keeps a confirmed save successful but blocks edits until failed readback recovers', async () => {
  await render(); const original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => { if (args[0].endsWith('/snapshot')) throw new Error('Unavailable'); return original(...args); });
  await act(async () => { await expect(result.act('update', { name: 'Saved' })).resolves.toEqual({ effects: [] }); });
  expect(result.editable).toBe(false); expect(result.reason).toBe('unavailable');
  request.mockImplementation(original); await act(async () => { await result.refresh(); });
  expect(result.group?.name).toBe('Saved'); expect(result.editable).toBe(true);
});

it('ignores pre-write snapshots and blocks duplicate edits while the write is pending', async () => {
  await render(); const original = request.getMockImplementation()!; let finishRead!: (value: unknown) => void; let first = true;
  request.mockImplementation(async (...args) => { if (args[0].endsWith('/snapshot') && first) { first = false; return new Promise(resolve => { finishRead = resolve; }); } return original(...args); });
  let oldRead!: Promise<void>; await act(async () => { oldRead = result.refresh(); });
  await expect(result.act('update', { name: 'Unverified' })).rejects.toThrow('PERMISSION_DENIED');
  await act(async () => { finishRead(structuredClone(snapshot)); await oldRead; });
  let finishWrite!: () => void;
  request.mockImplementation(async (...args) => { if (args[1] === 'PATCH') await new Promise<void>(resolve => { finishWrite = resolve; }); return original(...args); });
  let write!: Promise<unknown>; await act(async () => { write = result.act('update', { name: 'One write' }); });
  await expect(result.act('update', { name: 'Duplicate' })).rejects.toThrow('PERMISSION_DENIED');
  await act(async () => { finishWrite(); await write; });
  expect(writes()).toHaveLength(1);
});

it('discards account and closed-sheet read results and never revives their authorization', async () => {
  let finish!: (value: unknown) => void; const original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => args[0].endsWith('/snapshot') ? new Promise(resolve => { finish = resolve; }) : original(...args));
  await render(); const oldAct = result.act;
  h.enabled = false; h.api = api('account-2'); await render();
  await act(async () => { finish(structuredClone(snapshot)); });
  expect(result.group).toBeUndefined(); expect(result.editable).toBe(false);
  await expect(oldAct('update', { name: 'Late' })).rejects.toThrow('PERMISSION_DENIED');
  expect(writes()).toHaveLength(0);
});
