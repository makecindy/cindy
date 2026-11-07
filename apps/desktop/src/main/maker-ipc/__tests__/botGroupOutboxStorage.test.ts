// Test value: approved restart plan O1–O10. Public Main command/send entries with real atomic
// files cover the durable FIFO/claim/edit races that renderer transport mocks cannot exercise.
// Minimal failures: B prepares before A; renderer dies during Main send; hold/receipt ENOSPC;
// two windows consume the same hold. Unit tier: isolated tmp files, no network/SQLite/process.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotGroupSendInput, BotGroupSendResult } from '../../../shared/botGroupChat.js';
import type { BotGroupOutboxCommandRequest, BotGroupOutboxExecution, BotGroupOutboxStoredEntry } from '../../../shared/botGroupOutboxStorage.js';
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => ({ dataOwnerId: null, generation: 0 }),
  isAppSessionBoundaryPending: () => false, ownerScopedUserDataPath: () => '', onAppSessionInvalidated: () => () => {} }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../cindy-media/blobStore.js', () => ({ parseBlobUrl: () => null }));
vi.mock('../../cindy-media/ledger.js', () => ({}));
import * as atomic from '../../utils/atomicWriteFile.js';
import { createBotGroupOutboxStorage } from '../botGroupOutboxStorage.js';
import { createBotGroupOutboxIpc } from '../botGroupOutboxIpc.js';

type Storage = ReturnType<typeof createBotGroupOutboxStorage>;
let root: string;
let owner: { dataOwnerId: string; generation: number };
let boundary: boolean;
let refs: Map<string, Set<string>>;
let retain: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
const id = (row: BotGroupOutboxStoredEntry) => JSON.stringify([row.input.groupId, row.input.clientId]);
const file = (row: BotGroupOutboxStoredEntry) => path.join(root, owner.dataOwnerId,
  `${createHash('sha256').update(id(row)).digest('hex')}.json`);
const make = (publish?: () => void) => createBotGroupOutboxStorage({ currentOwner: () => owner, boundaryPending: () => boundary,
  ownerRoot: () => path.join(root, owner.dataOwnerId), retain: (entry, check) => retain(entry, check),
  release: (groupId, clientId) => release(groupId, clientId), publish });
function windowSender() {
  const emitter = new EventEmitter();
  let dead = false;
  const sender = Object.assign(emitter, { isDestroyed: () => dead }) as unknown as WebContents;
  return { sender, events: emitter, destroy: () => { dead = true; emitter.emit('destroyed'); } };
}
const draft = (clientId: string, groupId = 'room', createdAt = 1): BotGroupOutboxStoredEntry => ({
  input: { groupId, clientId, text: clientId, mentions: { all: false, allBots: true, botIds: [] } }, createdAt,
  draft: clientId, signature: 'untrusted-renderer-signature', attachmentScope: groupId, after: 0,
  tracked: [], attachments: [], status: 'sending', files: [],
});
const command = (storage: Storage, sender: WebContents, request: Omit<BotGroupOutboxCommandRequest, 'owner'> | Record<string, unknown>) =>
  storage.command(sender, { ...request, owner: { ...owner } });
const enqueue = (storage: Storage, sender: WebContents, row: BotGroupOutboxStoredEntry, operation = `enqueue-${row.input.clientId}`, editSource?: unknown) =>
  command(storage, sender, { action: 'enqueue', entry: row, enqueueOperationId: operation, editSource });
async function claim(storage: Storage, sender: WebContents, row: BotGroupOutboxStoredEntry): Promise<BotGroupOutboxExecution> {
  return (await command(storage, sender, { action: 'claim', groupId: row.input.groupId, clientId: row.input.clientId })).execution!;
}
const success = vi.fn<(input: BotGroupSendInput) => Promise<BotGroupSendResult>>(async () => ({ ok: true, messageId: 'receipt' }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cindy-main-outbox-'));
  owner = { dataOwnerId: 'account-a', generation: 1 }; boundary = false; refs = new Map();
  retain = vi.fn(async (entry: BotGroupOutboxStoredEntry, check: () => void) => {
    check(); const key = id(entry); const old = refs.get(key) ?? new Set();
    const next = new Set([...old, ...[...entry.files as Array<{ url?: string }>, ...entry.prepared as Array<{ url?: string }> ?? []].flatMap(row => row.url ? [row.url] : [])]);
    refs.set(key, next);
    return async () => { refs.set(key, old); };
  });
  release = vi.fn(async (groupId: string, clientId: string) => { refs.delete(JSON.stringify([groupId, clientId])); });
  success.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('executes the production IPC adapters with actual sender ownership and legacy-send compatibility', async () => {
  const storage = make(); const a = windowSender().sender; const b = windowSender().sender;
  const ipc = createBotGroupOutboxIpc({ command: storage.command, send: storage.send, service: success,
    assertCommandSender: () => {}, assertSendSender: () => {} });
  const event = (sender: WebContents) => ({ sender }) as IpcMainInvokeEvent;
  const row = draft('ipc');
  await ipc.command(event(a), { action: 'enqueue', owner, entry: row, enqueueOperationId: 'ipc-operation' });
  const execution = (await ipc.command(event(a), { action: 'claim', owner, groupId: 'room', clientId: 'ipc' })).execution!;
  await expect(ipc.send(event(b), row.input, execution)).rejects.toThrow('STALE_EXECUTION');
  expect(success).not.toHaveBeenCalled();
  await ipc.send(event(a), row.input, execution);
  expect(success).toHaveBeenCalledWith(row.input);
  const legacy = draft('legacy');
  await ipc.send(event(windowSender().sender), legacy.input, undefined);
  expect(success).toHaveBeenLastCalledWith(legacy.input);
});

it('checks the production IPC sender gate before consulting the command or send storage', () => {
  const storage = make(); const command = vi.spyOn(storage, 'command'); const send = vi.spyOn(storage, 'send');
  const reject = () => { throw new Error('untrusted window'); };
  const ipc = createBotGroupOutboxIpc({ command: storage.command, send: storage.send, service: success, assertCommandSender: reject, assertSendSender: reject });
  const event = { sender: windowSender().sender } as IpcMainInvokeEvent;
  expect(() => ipc.command(event, { action: 'snapshot', owner })).toThrow('untrusted window');
  expect(() => ipc.send(event, draft('x').input, undefined)).toThrow('untrusted window');
  expect(command).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
});

it('persists Main enqueue order, not renderer clocks or preparation/claim order, across restart', async () => {
  let storage = make(); const a = windowSender().sender; const b = windowSender().sender;
  const first = draft('a', 'room', 900); const second = draft('b', 'room', 1);
  first.files = [{ id: 'image', url: 'cindy-media://original.png', name: 'image.png' }];
  await enqueue(storage, a, first); await enqueue(storage, b, second);
  const executionB = await claim(storage, b, second);
  await expect(storage.send(b, second.input as unknown as BotGroupSendInput, executionB, success)).rejects.toThrow('WAITING_FOR_HEAD');
  expect(success).not.toHaveBeenCalled();
  storage = make();
  const saved = (await command(storage, b, { action: 'snapshot' })).entries;
  expect(saved.map(row => [row.input.clientId, row.queueOrdinal])).toEqual([['a', 1], ['b', 2]]);
  const executionA = await claim(storage, a, first);
  const prepared = [{ id: 'burned', name: 'image.png', url: 'cindy-media://burned.png' }];
  await command(storage, a, { action: 'prepared', execution: executionA, prepared, attachments: [] });
  const inputA = { ...first.input, attachments: [{ id: 'burned', name: 'image.png', originalName: 'image.png', url: 'cindy-media://burned.png' }] } as unknown as BotGroupSendInput;
  await storage.send(a, inputA, executionA, success);
  await storage.send(b, second.input as unknown as BotGroupSendInput, await claim(storage, b, second), success);
  expect(success.mock.calls.map(([input]) => input.clientId)).toEqual(['a', 'b']);
  expect(JSON.parse(readFileSync(file(first), 'utf8'))).toMatchObject({ status: 'sent', messageId: 'receipt', queueOrdinal: 1 });
});

it('snapshot does not claim, competing windows cannot steal, same-owner repair preserves an active claim', async () => {
  const storage = make(); const a = windowSender().sender; const b = windowSender().sender; const row = draft('a');
  await enqueue(storage, a, row);
  await command(storage, b, { action: 'snapshot' });
  const execution = await claim(storage, a, row);
  owner = { ...owner, generation: 2 };
  await command(storage, b, { action: 'snapshot' });
  await expect(claim(storage, b, row)).rejects.toThrow('ALREADY_CLAIMED');
  const repaired = await claim(storage, a, row);
  expect(repaired.claimToken).toBe(execution.claimToken);
  await expect(storage.send(a, row.input as unknown as BotGroupSendInput, execution, success)).rejects.toThrow('OWNER_CHANGED');
  await storage.send(a, row.input as unknown as BotGroupSendInput, repaired, success);
});

it.each(['destroyed', 'render-process-gone', 'did-navigate'])('%s releases preparation but not a Main request still in flight', async event => {
  const storage = make(); const a = windowSender(); const b = windowSender().sender; const row = draft('a');
  await enqueue(storage, a.sender, row);
  const execution = await claim(storage, a.sender, row);
  const network = deferred<BotGroupSendResult>(); const entered = deferred<void>();
  const sending = storage.send(a.sender, row.input as unknown as BotGroupSendInput, execution, async () => { entered.resolve(); return network.promise; });
  await entered.promise; a.events.emit(event);
  await expect(claim(storage, b, row)).rejects.toThrow('NOT_CLAIMABLE');
  network.resolve({ ok: true, messageId: 'survived-crash' }); await sending;
  const snapshot = await command(storage, b, { action: 'snapshot' });
  expect(snapshot.entries[0]).toMatchObject({ status: 'sent', messageId: 'survived-crash' });
  expect(JSON.parse(readFileSync(file(row), 'utf8')).messageId).toBe('survived-crash');
});

it('allows another ready full window to recover after a preparation crash and invalidates the old token', async () => {
  const storage = make(); const a = windowSender(); const b = windowSender().sender; const row = draft('a');
  await enqueue(storage, a.sender, row); const old = await claim(storage, a.sender, row);
  a.destroy(); const recovered = await claim(storage, b, row);
  await expect(storage.send(a.sender, row.input as unknown as BotGroupSendInput, old, success)).rejects.toThrow('STALE_EXECUTION');
  await storage.send(b, row.input as unknown as BotGroupSendInput, recovered, success);
  expect(success).toHaveBeenCalledTimes(1);
});

it('rechecks the admitted owner at the service call edge and settles an invalidated admission as retryable', async () => {
  let armed = false;
  const storage = make(() => { if (armed) { armed = false; queueMicrotask(() => { owner = { ...owner, generation: 2 }; }); } });
  const sender = windowSender().sender; const row = draft('a');
  await enqueue(storage, sender, row); const execution = await claim(storage, sender, row);
  armed = true;
  const outcome = await storage.send(sender, row.input as unknown as BotGroupSendInput, execution, success);
  expect(success).not.toHaveBeenCalled();
  expect(outcome.ok).toBe(false);
  const settled = await command(storage, sender, { action: 'snapshot' });
  expect(settled.entries[0]).toMatchObject({ status: 'failed', retryable: true });
  expect(await claim(storage, sender, row)).toBeDefined();
});

it('does not hold the storage queue over a network promise, and sending wins its edit race', async () => {
  const storage = make(); const sender = windowSender().sender;
  const slow = draft('slow', 'one'); const other = draft('other', 'two');
  const accepted = await enqueue(storage, sender, slow); await enqueue(storage, sender, other);
  const network = deferred<BotGroupSendResult>(); const entered = deferred<void>();
  const sending = storage.send(sender, slow.input as unknown as BotGroupSendInput, await claim(storage, sender, slow), async () => { entered.resolve(); return network.promise; });
  await entered.promise;
  await expect(command(storage, sender, { action: 'edit', groupId: 'one', clientId: 'slow', entryRevision: accepted.entry!.entryRevision, operationId: 'edit-slow' })).rejects.toThrow('BUSY');
  await storage.send(sender, other.input as unknown as BotGroupSendInput, await claim(storage, sender, other), success);
  expect(success).toHaveBeenCalledTimes(1);
  network.resolve({ ok: true, messageId: 'slow-receipt' }); await sending;
});

it('edit wins before service, persists a rollback-compatible hold and retains original media across restart', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  row.files = [{ id: 'image', url: 'cindy-media://original.png' }];
  const accepted = await enqueue(storage, sender, row); const execution = await claim(storage, sender, row);
  const request = { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' };
  const held = await command(storage, sender, request);
  expect(held.entry).toMatchObject({ status: 'failed', retryable: false, editHold: { operationId: 'hold-a', revision: 2 } });
  expect((await command(storage, sender, request)).entry).toEqual(held.entry);
  await expect(storage.send(sender, row.input as unknown as BotGroupSendInput, execution, success)).rejects.toThrow('STALE_EXECUTION');
  const restored = await command(make(), sender, { action: 'snapshot' });
  expect(restored.entries[0]).toMatchObject({ ...row, status: 'failed', retryable: false });
  expect(refs.get(id(row))).toContain('cindy-media://original.png');
  await expect(claim(make(), sender, row)).rejects.toThrow('NOT_CLAIMABLE');
  expect(success).not.toHaveBeenCalled();
});

it('failed hold writes freeze execution and FIFO until the cancellation intent commits after same-owner repair', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a'); const next = draft('b');
  const accepted = await enqueue(storage, sender, row); await enqueue(storage, sender, next);
  const old = await claim(storage, sender, row); const second = await claim(storage, sender, next);
  const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('ENOSPC private/path'); });
  await expect(command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' })).rejects.toThrow('OUTBOX_STORAGE_FAILED');
  await expect(storage.send(sender, row.input as unknown as BotGroupSendInput, old, success)).rejects.toThrow('STALE_EXECUTION');
  await expect(storage.send(sender, next.input as unknown as BotGroupSendInput, second, success)).rejects.toThrow('WAITING_FOR_HEAD');
  expect(JSON.parse(readFileSync(file(row), 'utf8')).editHold).toBeUndefined();
  owner = { ...owner, generation: 2 }; write.mockRestore();
  await command(storage, sender, { action: 'snapshot' });
  expect(JSON.parse(readFileSync(file(row), 'utf8'))).toMatchObject({ status: 'failed', retryable: false, editHold: { operationId: 'hold-a' } });
  await storage.send(sender, next.input as unknown as BotGroupSendInput, await claim(storage, sender, next), success);
  expect(success.mock.calls[0]![0].clientId).toBe('b');
});

it('same-ID edit resend is a new execution at the tail; enqueue acknowledgement loss is idempotent', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  const accepted = await enqueue(storage, sender, row); const old = await claim(storage, sender, row);
  const held = await command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'edit-a' });
  await enqueue(storage, sender, draft('b'));
  const source = { groupId: 'room', clientId: 'a', revision: held.entry!.editHold!.revision };
  const sent = await enqueue(storage, sender, row, 'explicit-again', source);
  const again = await enqueue(storage, sender, row, 'explicit-again', source);
  expect(again.entry).toEqual(sent.entry); expect(again.entries.map(row => row.input.clientId)).toEqual(['b', 'a']);
  expect(again.entry!.queueOrdinal).toBe(3);
  expect(again.entry!.editHold).toBeUndefined();
  await expect(storage.send(sender, row.input as unknown as BotGroupSendInput, old, success)).rejects.toThrow('STALE_EXECUTION');
  const changed = { ...row, input: { ...row.input, text: 'different' } };
  await expect(enqueue(storage, sender, changed, 'explicit-again', source)).rejects.toThrow('OPERATION_CONFLICT');
  expect((await command(storage, sender, { action: 'snapshot' })).entries.find(row => row.input.clientId === 'a')!.input.text).toBe('a');
});

it('rejects a stale entryRevision at claim rather than granting the token for an edited replacement', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  const accepted = await enqueue(storage, sender, row);
  const held = await command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' });
  const source = { groupId: 'room', clientId: 'a', revision: held.entry!.editHold!.revision };
  const replacement = await enqueue(storage, sender, row, 'again', source);
  await expect(command(storage, sender, { action: 'claim', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision })).rejects.toThrow('STALE_ENTRY');
  expect((await command(storage, sender, { action: 'claim', groupId: 'room', clientId: 'a', entryRevision: replacement.entry!.entryRevision })).execution).toBeDefined();
});

it('answers accepted operation retries after target cleanup in-process, but does not rebuild missing sources after restart', async () => {
  const storage = make(); const sender = windowSender().sender; const original = draft('a');
  const accepted = await enqueue(storage, sender, original);
  const held = await command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' });
  const source = { groupId: 'room', clientId: 'a', revision: held.entry!.editHold!.revision };
  const replacement = draft('replacement');
  const enqueued = await enqueue(storage, sender, replacement, 'accepted-operation', source);
  await storage.send(sender, replacement.input as unknown as BotGroupSendInput, await claim(storage, sender, replacement), success);
  await command(storage, sender, { action: 'remove', groupId: 'room', clientId: 'replacement', entryRevision: enqueued.entry!.entryRevision });
  const repeated = await enqueue(storage, sender, replacement, 'accepted-operation', source);
  expect(repeated.accepted).toBe(true); expect(repeated.entries).toEqual([]);
  expect(readdirSync(path.dirname(file(original)))).toEqual([]);
  await expect(enqueue(make(), sender, replacement, 'accepted-operation', source)).rejects.toThrow('SOURCE_CONSUMED');
  expect(success).toHaveBeenCalledTimes(1);
});

it('different-ID handoff recovers an interrupted source cleanup, never sends old content or consumes a hold twice', async () => {
  let storage = make(); const a = windowSender().sender; const b = windowSender().sender; const original = draft('a');
  original.files = [{ id: 'old', url: 'cindy-media://old.png' }];
  const accepted = await enqueue(storage, a, original);
  const held = await command(storage, a, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'edit-a' });
  const source = { groupId: 'room', clientId: 'a', revision: held.entry!.editHold!.revision };
  const replacement = draft('new'); replacement.files = [{ id: 'new', url: 'cindy-media://new.png' }];
  const realWrite = atomic.atomicWriteFileSync;
  const blocked = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation((filename, raw) => {
    if (filename === file(original)) throw new Error('source cleanup blocked'); realWrite(filename, raw);
  });
  const result = await enqueue(storage, a, replacement, 'replace-a', source);
  expect(result.accepted).toBe(true); expect(result.entries.map(row => row.input.clientId)).toEqual(['new']);
  expect(JSON.parse(readFileSync(file(replacement), 'utf8')).editSource).toEqual(source);
  await expect(command(storage, a, { action: 'remove', groupId: 'room', clientId: 'new', entryRevision: result.entry!.entryRevision })).rejects.toThrow('TRANSFER_PENDING');
  await expect(enqueue(storage, b, draft('competitor'), 'replace-competing', source)).rejects.toThrow('SOURCE_CONSUMED');
  expect(refs.get(id(original))).toContain('cindy-media://old.png');
  expect(refs.get(id(replacement))).toContain('cindy-media://new.png');
  blocked.mockRestore(); storage = make();
  const restored = await command(storage, b, { action: 'snapshot' });
  expect(restored.entries.map(row => row.input.clientId)).toEqual(['new']);
  expect(restored.entries[0]!.editSource).toBeUndefined();
  expect(restored.entries[0]!.enqueueSource).toEqual(source);
  expect(refs.has(id(original))).toBe(false);
  expect((await enqueue(storage, a, replacement, 'replace-a', source)).entry!.queueOrdinal).toBe(restored.entries[0]!.queueOrdinal);
});

it('same operation cannot change target, source, annotations or payload even when the renderer signature lies', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  row.files = [{ id: 'image', url: 'cindy-media://image.png', annotationStrokes: [] }];
  await enqueue(storage, sender, row, 'immutable');
  for (const changed of [
    { ...row, input: { ...row.input, clientId: 'b' } },
    { ...row, input: { ...row.input, mentions: { all: true, botIds: [] } } },
    { ...row, files: [{ id: 'image', url: 'cindy-media://image.png', annotationStrokes: [{ x: 1 }] }] },
  ]) await expect(enqueue(storage, sender, changed, 'immutable')).rejects.toThrow('OPERATION_CONFLICT');
});

it('settlement write failure keeps the head blocked, retries the known result without another network call', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a'); const next = draft('b');
  await enqueue(storage, sender, row); await enqueue(storage, sender, next);
  const first = await claim(storage, sender, row); const second = await claim(storage, sender, next);
  const network = deferred<BotGroupSendResult>(); const entered = deferred<void>();
  const pending = storage.send(sender, row.input as unknown as BotGroupSendInput, first, async () => { entered.resolve(); return network.promise; });
  await entered.promise;
  const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('ENOSPC'); });
  network.resolve({ ok: true, messageId: 'accepted-but-not-saved' }); await pending;
  await expect(storage.send(sender, next.input as unknown as BotGroupSendInput, second, success)).rejects.toThrow('WAITING_FOR_HEAD');
  await expect(claim(storage, sender, row)).rejects.toThrow('NOT_CLAIMABLE');
  write.mockRestore(); await command(storage, sender, { action: 'snapshot' });
  expect(JSON.parse(readFileSync(file(row), 'utf8'))).toMatchObject({ status: 'sent', messageId: 'accepted-but-not-saved' });
  await storage.send(sender, next.input as unknown as BotGroupSendInput, second, success);
  expect(success).toHaveBeenCalledTimes(1);
});

it('transport failures retry the original clientId/payload but content refusals do not auto-retry', async () => {
  let storage = make(); const sender = windowSender().sender; const row = draft('a');
  await enqueue(storage, sender, row);
  await storage.send(sender, row.input as unknown as BotGroupSendInput, await claim(storage, sender, row), async () => { throw new Error('connection lost'); });
  storage = make();
  const failed = (await command(storage, sender, { action: 'snapshot' })).entries[0]!;
  expect(failed).toMatchObject({ status: 'failed', retryable: true });
  const refusing = vi.fn<(input: BotGroupSendInput) => Promise<BotGroupSendResult>>(async () => ({ ok: false, errorCode: 'QUOTE_UNAVAILABLE', message: 'gone' }));
  await storage.send(sender, row.input as unknown as BotGroupSendInput, await claim(storage, sender, row), refusing);
  expect(refusing.mock.calls[0]![0]).toEqual(row.input);
  expect((await command(storage, sender, { action: 'snapshot' })).entries[0]).toMatchObject({ status: 'failed', retryable: false, quote: null });
  await expect(claim(storage, sender, row)).rejects.toThrow('NOT_CLAIMABLE');
});

it('rejects old put/send and stale prepared/fail updates after hold, sent, and removal', async () => {
  const storage = make(); const sender = windowSender().sender; const legacy = windowSender().sender; const row = draft('a');
  const accepted = await enqueue(storage, sender, row); const execution = await claim(storage, sender, row);
  await command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' });
  await expect(storage.access({ action: 'put', owner, entry: row })).rejects.toThrow('EXECUTION_REQUIRED');
  await expect(storage.send(legacy, row.input as unknown as BotGroupSendInput, undefined, success)).rejects.toThrow('EXECUTION_REQUIRED');
  await expect(command(storage, sender, { action: 'prepared', execution, prepared: [], attachments: [] })).rejects.toThrow('STALE_EXECUTION');
  const held = (await command(storage, sender, { action: 'snapshot' })).entries[0]!;
  await command(storage, sender, { action: 'remove', groupId: 'room', clientId: 'a', entryRevision: held.entryRevision });
  await expect(command(storage, sender, { action: 'fail', execution, retryable: true, errorKey: 'failure' })).rejects.toThrow('STALE_EXECUTION');
  await expect(storage.send(legacy, row.input as unknown as BotGroupSendInput, undefined, success)).rejects.toThrow('EXECUTION_REQUIRED');
  await storage.send(legacy, draft('not-outbox').input as unknown as BotGroupSendInput, undefined, success);
  expect(success).toHaveBeenCalledTimes(1);
});

it('reconstructs service input from saved prepared attachments and refuses a modified send payload', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  row.files = [{ id: 'source', url: 'cindy-media://source.png' }];
  await enqueue(storage, sender, row); const execution = await claim(storage, sender, row);
  await command(storage, sender, { action: 'prepared', execution, prepared: [{ id: 'prepared', name: 'burned.png', url: 'cindy-media://burned.png', baseAnnotated: true }], attachments: [] });
  await expect(storage.send(sender, { ...row.input, text: 'tampered' } as unknown as BotGroupSendInput, execution, success)).rejects.toThrow('INPUT_CONFLICT');
  const input = { ...row.input, attachments: [{ id: 'prepared', name: 'burned.png', originalName: 'burned.png', url: 'cindy-media://burned.png', annotated: true }] } as unknown as BotGroupSendInput;
  await storage.send(sender, input, execution, success);
  expect(success.mock.calls[0]![0]).toEqual(input);
  expect(success.mock.calls[0]![0]).not.toHaveProperty('execution');
});

it.each(['EACCES', 'EBUSY', 'ATOMIC_BACKUP_UNRECOVERABLE'])('retries an unreadable durable queue head after %s without sending its successor', async code => {
  const first = draft('unreadable-first'); const second = draft('readable-second');
  const sender = windowSender().sender;
  const original = make();
  await enqueue(original, sender, first); await enqueue(original, sender, second);
  const restarted = make();
  const read = atomic.readAtomicFileSync;
  let locked = true;
  vi.spyOn(atomic, 'readAtomicFileSync').mockImplementation(filename => {
    if (locked && filename === file(first)) {
      if (code === 'ATOMIC_BACKUP_UNRECOVERABLE') throw new atomic.AtomicBackupUnrecoverableError(filename);
      throw Object.assign(new Error('queue head temporarily unreadable'), { code });
    }
    return read(filename);
  });
  await expect(command(restarted, sender, { action: 'snapshot' })).rejects.toThrow('OUTBOX_STORAGE_FAILED');
  await expect(restarted.send(sender, second.input as unknown as BotGroupSendInput, undefined, success)).rejects.toThrow('OUTBOX_STORAGE_FAILED');
  expect(success).not.toHaveBeenCalled();
  locked = false;
  const recovered = await command(restarted, sender, { action: 'snapshot' });
  expect(recovered.entries.map(row => row.input.clientId)).toEqual(['unreadable-first', 'readable-second']);
  const secondExecution = await claim(restarted, sender, second);
  await expect(restarted.send(sender, second.input as unknown as BotGroupSendInput, secondExecution, success)).rejects.toThrow('WAITING_FOR_HEAD');
  const firstExecution = await claim(restarted, sender, first);
  await restarted.send(sender, first.input as unknown as BotGroupSendInput, firstExecution, success);
  await restarted.send(sender, second.input as unknown as BotGroupSendInput, secondExecution, success);
  expect(success.mock.calls.map(([input]) => input.clientId)).toEqual(['unreadable-first', 'readable-second']);
});

it('does not rescan/reparse large active payloads on repeated recovery snapshots or claims', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a'); row.draft = 'x'.repeat(200_000);
  await enqueue(storage, sender, row); await claim(storage, sender, row);
  const restarted = make(); const read = vi.spyOn(atomic, 'readAtomicFileSync');
  let snapshot = await command(restarted, sender, { action: 'snapshot' }); const coldReads = read.mock.calls.length;
  expect(coldReads).toBe(1);
  for (let tick = 0; tick < 4; tick++) {
    const known = { instanceId: snapshot.instanceId, revision: snapshot.revision };
    const unchanged = await command(restarted, sender, { action: 'snapshot', known });
    expect(unchanged).toMatchObject({ unchanged: true, entries: [] });
    expect(JSON.stringify(unchanged).length).toBeLessThan(300);
    snapshot = await command(restarted, sender, { action: 'snapshot' });
  }
  expect(read).toHaveBeenCalledTimes(coldReads);
  expect((await command(make(), sender, { action: 'snapshot', known: snapshot })).entries).toHaveLength(1);
});

it('migrates unnumbered rows after existing ordinals and isolates corrupt/duplicate queues', async () => {
  const a = draft('a'); const legacy = draft('legacy', 'room', -99); const corrupt = draft('corrupt', 'broken'); const duplicate = draft('duplicate', 'broken');
  a.queueOrdinal = 5; corrupt.queueOrdinal = 1; duplicate.queueOrdinal = 1;
  mkdirSync(path.dirname(file(a)), { recursive: true });
  for (const row of [a, legacy, corrupt, duplicate]) writeFileSync(file(row), JSON.stringify(row));
  writeFileSync(path.join(path.dirname(file(a)), `${'0'.repeat(64)}.json`), '{damaged');
  const storage = make(); const sender = windowSender().sender;
  const snapshot = await command(storage, sender, { action: 'snapshot' });
  expect(snapshot.entries.find(row => row.input.clientId === 'legacy')!.queueOrdinal).toBe(6);
  await expect(claim(storage, sender, corrupt)).rejects.toThrow('QUEUE_INVALID');
  await storage.send(sender, a.input as unknown as BotGroupSendInput, await claim(storage, sender, a), success);
  const reloaded = await command(make(), sender, { action: 'snapshot' });
  expect(reloaded.entries.find(row => row.input.clientId === 'legacy')!.queueOrdinal).toBe(6);
});

it('explicit worker release hands off preparation without freeing a Main in-flight request', async () => {
  const storage = make(); const a = windowSender().sender; const b = windowSender().sender;
  const row = draft('a'); const next = draft('b');
  await enqueue(storage, a, row); await enqueue(storage, a, next);
  const old = await claim(storage, a, row);
  await command(storage, a, { action: 'release' });
  const recovered = await claim(storage, b, row);
  expect(recovered.claimToken).not.toBe(old.claimToken);
  await expect(storage.send(a, row.input as unknown as BotGroupSendInput, old, success)).rejects.toThrow('STALE_EXECUTION');
  const pending = deferred<BotGroupSendResult>(); const entered = deferred<void>();
  const sending = storage.send(b, row.input as unknown as BotGroupSendInput, recovered, async () => { entered.resolve(); return pending.promise; });
  await entered.promise;
  await command(storage, b, { action: 'release' });
  await expect(claim(storage, a, row)).rejects.toThrow('NOT_CLAIMABLE');
  await expect(storage.send(a, next.input as unknown as BotGroupSendInput, await claim(storage, a, next), success)).rejects.toThrow('WAITING_FOR_HEAD');
  pending.resolve({ ok: true, messageId: 'settled-after-worker-stopped' }); await sending;
  expect((await command(storage, a, { action: 'snapshot' })).entries[0]!.messageId).toBe('settled-after-worker-stopped');
});

it('does not replay an uncommitted edit intent after a real account switch, unlike a generation repair', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  const accepted = await enqueue(storage, sender, row);
  const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('ENOSPC'); });
  await expect(command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'not-committed' })).rejects.toThrow('OUTBOX_STORAGE_FAILED');
  write.mockRestore();
  owner = { dataOwnerId: 'account-b', generation: 2 }; storage.observeOwner();
  owner = { dataOwnerId: 'account-a', generation: 3 }; storage.observeOwner();
  const snapshot = await command(storage, sender, { action: 'snapshot' });
  expect(snapshot.entries[0]!.editHold).toBeUndefined();
  expect(snapshot.entries[0]!.status).toBe('sending');
});

it('atomic same-ID re-enqueue failure keeps the hold and its only media reference recoverable', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  row.files = [{ id: 'image', url: 'cindy-media://original.png' }];
  const accepted = await enqueue(storage, sender, row);
  const held = await command(storage, sender, { action: 'edit', groupId: 'room', clientId: 'a', entryRevision: accepted.entry!.entryRevision, operationId: 'hold-a' });
  const source = { groupId: 'room', clientId: 'a', revision: held.entry!.editHold!.revision };
  const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementationOnce(() => { throw new Error('ENOSPC'); });
  await expect(enqueue(storage, sender, row, 'try-again', source)).rejects.toThrow('OUTBOX_STORAGE_FAILED');
  expect(JSON.parse(readFileSync(file(row), 'utf8'))).toMatchObject({ status: 'failed', retryable: false, editHold: held.entry!.editHold });
  expect(refs.get(id(row))).toContain('cindy-media://original.png');
  write.mockRestore();
  expect((await command(make(), sender, { action: 'snapshot' })).entries[0]!.editHold).toEqual(held.entry!.editHold);
  const committed = await enqueue(storage, sender, row, 'try-again', source);
  expect(committed.entry!.queueOrdinal).toBeGreaterThan(accepted.entry!.queueOrdinal!);
});

it('fences an owner switch during media retention without committing into either account', async () => {
  const storage = make(); const sender = windowSender().sender; const row = draft('a');
  const oldOwner = { ...owner }; const pending = deferred<void>(); const entered = deferred<void>();
  retain.mockImplementationOnce(async (_row, check) => { entered.resolve(); await pending.promise; check(); return async () => {}; });
  const attempt = enqueue(storage, sender, row); await entered.promise;
  owner = { dataOwnerId: 'account-b', generation: 2 }; pending.resolve();
  await expect(attempt).rejects.toThrow('OWNER_CHANGED');
  expect(readdirSync(root)).toEqual([]);
  expect((await command(storage, sender, { action: 'snapshot' })).entries).toEqual([]);
  await expect(storage.command(sender, { action: 'snapshot', owner: oldOwner })).rejects.toThrow('OWNER_CHANGED');
});
