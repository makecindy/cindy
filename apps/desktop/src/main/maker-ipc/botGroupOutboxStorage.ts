import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WebContents } from 'electron';
import { z } from 'zod';
import { botGroupErrorVariant } from '@cindy/maker-shared/botGroupPresentation';
import { getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { parseBlobUrl } from '../cindy-media/blobStore.desktop.js';
import * as ledger from '../cindy-media/ledger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { BotGroupSendInput, BotGroupSendResult } from '../../shared/botGroupChat.js';
import type {
  BotGroupOutboxChanged, BotGroupOutboxCommandRequest, BotGroupOutboxCommandResult,
  BotGroupOutboxEditSource, BotGroupOutboxExecution, BotGroupOutboxOwner, BotGroupOutboxStoredEntry,
} from '../../shared/botGroupOutboxStorage.js';

const identifier = z.string().min(1).max(200);
const ownerSchema = z.object({ dataOwnerId: identifier, generation: z.number().int().nonnegative() });
const mediaSchema = z.object({ url: z.string().optional(), annotationSourceUrl: z.string().optional() }).passthrough();
const entrySchema = z.object({ input: z.object({ groupId: identifier, clientId: identifier, text: z.string().max(8000),
  mentions: z.object({ all: z.boolean(), allBots: z.boolean().optional(), botIds: z.array(identifier).max(200) }),
  conversationKind: z.literal('direct').optional(), division: z.boolean().optional(),
}).passthrough(), createdAt: z.number().finite(), status: z.enum(['sending', 'sent', 'failed']),
  draft: z.string(), signature: z.string(), attachmentScope: z.string(), after: z.number().finite(),
  tracked: z.array(z.unknown()), attachments: z.array(z.unknown()).max(32),
  files: z.array(mediaSchema).max(32), prepared: z.array(mediaSchema).max(32).optional(),
}).passthrough();
const sourceSchema = z.object({ groupId: identifier, clientId: identifier, revision: z.number().int().positive() });
const executionSchema = z.object({ owner: ownerSchema, instanceId: identifier, groupId: identifier, clientId: identifier,
  entryRevision: z.number().int().positive(), claimToken: identifier });
const identitySchema = { groupId: identifier, clientId: identifier };
const revisionSchema = { ...identitySchema, entryRevision: z.number().int().positive() };
const commandSchema = z.intersection(z.object({ owner: ownerSchema }), z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), known: z.object({ instanceId: identifier, revision: z.number().int().nonnegative() }).optional() }),
  z.object({ action: z.literal('enqueue'), entry: entrySchema, enqueueOperationId: identifier, editSource: sourceSchema.optional() }),
  z.object({ action: z.literal('claim'), ...identitySchema, entryRevision: z.number().int().positive().optional() }),
  z.object({ action: z.literal('prepared'), execution: executionSchema, prepared: z.array(mediaSchema).max(32), attachments: z.array(z.unknown()).max(32) }),
  z.object({ action: z.literal('fail'), execution: executionSchema, errorKey: z.string().max(200), retryable: z.boolean() }),
  z.object({ action: z.literal('retry'), ...revisionSchema }),
  z.object({ action: z.literal('edit'), ...revisionSchema, operationId: identifier }),
  z.object({ action: z.literal('remove'), ...revisionSchema }),
  z.object({ action: z.literal('release') }),
]));
const legacySchema = z.intersection(z.object({ owner: ownerSchema }), z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }), z.object({ action: z.literal('put'), entry: entrySchema }),
  z.object({ action: z.literal('remove'), ...identitySchema }),
]));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keyOf = (groupId: string, clientId: string) => JSON.stringify([groupId, clientId]);
const rowKey = (entry: BotGroupOutboxStoredEntry) => keyOf(entry.input.groupId, entry.input.clientId);
const queueKey = (entry: BotGroupOutboxStoredEntry) => JSON.stringify([entry.input.conversationKind ?? 'group', entry.input.groupId]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
}
/** Same business identity as botGroupSendSignature, calculated here, never trusted from the UI. */
function signature(entry: BotGroupOutboxStoredEntry): string {
  const files = entry.files as Array<Record<string, unknown>>;
  return canonical([{ ...entry.input, clientId: undefined }, files.map(file => [file.id, file.url ?? file.path, file.annotationStrokes ?? null])]);
}
function fail(reason: string): never { return throwIpcError('INVALID_PARAMS', `OUTBOX_${reason}`); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) return throwIpcError('INVALID_PARAMS', 'OUTBOX_INVALID_PARAMS');
  return result.data;
}
function storageFailure(error: unknown): never {
  if (isIpcError(error)) throw error;
  return throwIpcError('INTERNAL', 'OUTBOX_STORAGE_FAILED');
}
const permanent = new Set(['QUOTE_UNAVAILABLE', 'MENTION_UNAVAILABLE', 'ALL_BOTS_MENTION_DISABLED',
  'INVALID_PARAMS', 'INVALID_ATTACHMENT', 'ATTACHMENT_TOO_LARGE', 'NOT_FOUND', 'PERMISSION_DENIED']);

/** The IPC adapter already authenticates a complete application window. Identity is the actual object. */
type Sender = Pick<WebContents, 'isDestroyed' | 'on' | 'removeListener'>;
interface Claim { sender: Sender; token: string; revision: number; owner: BotGroupOutboxOwner }
interface PendingIntent { action: 'edit' | 'remove'; revision: number; operationId?: string }
interface Settlement { entryRevision: number; result: BotGroupSendResult }
interface AcceptedOperation { key: string; signatureHash: string; source?: BotGroupOutboxEditSource }
const acceptedOperation = (row: BotGroupOutboxStoredEntry): AcceptedOperation => ({
  key: rowKey(row), signatureHash: hash(row.businessSignature ?? ''), source: row.enqueueSource,
});
interface Account {
  ownerId: string; root: string; revision: number; loaded: boolean;
  rows: Map<string, BotGroupOutboxStoredEntry>; claims: Map<string, Claim>;
  high: Map<string, number>; blocked: Set<string>; migrationFailed: Set<string>; protected: Set<string>;
  operations: Map<string, AcceptedOperation>; intents: Map<string, PendingIntent>;
  tombstones: Map<string, BotGroupOutboxStoredEntry>;
  inFlight: Map<string, number>; settlements: Map<string, Settlement>;
}
interface StorageDependencies {
  currentOwner: () => BotGroupOutboxOwner;
  boundaryPending: () => boolean;
  ownerRoot: () => string;
  /** Add references before replacement. The returned rollback releases only references just added. */
  retain: (entry: BotGroupOutboxStoredEntry, check: () => void) => Promise<() => Promise<void>>;
  release: (groupId: string, clientId: string) => Promise<void>;
  publish?: (event: BotGroupOutboxChanged) => void;
}

/** One existing outbox, one storage queue. No network await ever runs inside serial(). */
export function createBotGroupOutboxStorage(deps: StorageDependencies) {
  const instanceId = randomUUID();
  const accounts = new Map<string, Account>();
  const enabled = new WeakSet<Sender>();
  const watching = new WeakSet<Sender>();
  let chain = Promise.resolve<unknown>(undefined);
  let lastOwner: string | null = null;
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.then(operation);
    chain = pending.catch(() => undefined);
    return pending;
  };
  const check = (owner: BotGroupOutboxOwner) => {
    const now = deps.currentOwner();
    if (deps.boundaryPending() || !owner.dataOwnerId || now.dataOwnerId !== owner.dataOwnerId || now.generation !== owner.generation) fail('OWNER_CHANGED');
  };
  const filename = (state: Account, key: string) => path.join(state.root, `${hash(key)}.json`);
  const publish = (state: Account) => {
    state.revision += 1;
    const owner = deps.currentOwner();
    if (!deps.boundaryPending() && owner.dataOwnerId === state.ownerId) {
      try { deps.publish?.({ owner: { ...owner }, instanceId, revision: state.revision }); } catch { /* Invalidation hints cannot undo a commit. */ }
    }
  };
  async function save(state: Account, entry: BotGroupOutboxStoredEntry, owner: BotGroupOutboxOwner) {
    const raw = JSON.stringify(entry);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) fail('TOO_LARGE');
    check(owner);
    const rollback = await deps.retain(entry, () => check(owner));
    try {
      check(owner);
      mkdirSync(state.root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(filename(state, rowKey(entry)), raw);
    } catch (error) { await rollback().catch(() => undefined); throw error; }
    state.rows.set(rowKey(entry), entry);
    if (entry.coordinated) state.protected.add(rowKey(entry));
    if (entry.enqueueOperationId) state.operations.set(entry.enqueueOperationId, acceptedOperation(entry));
    publish(state);
  }
  async function erase(state: Account, key: string, owner: BotGroupOutboxOwner) {
    check(owner);
    const row = state.rows.get(key);
    if (!row) return;
    mkdirSync(state.root, { recursive: true, mode: 0o700 });
    // A committed null wins over .bak even when reference release/cleanup subsequently fails.
    atomicWriteFileSync(filename(state, key), 'null');
    state.rows.delete(key); state.claims.delete(key); state.intents.delete(key);
    state.tombstones.set(key, row);
    state.protected.add(key); publish(state);
    await cleanupTombstone(state, key, row, owner);
  }
  async function cleanupTombstone(state: Account, key: string, row: BotGroupOutboxStoredEntry, owner: BotGroupOutboxOwner) {
    await deps.release(row.input.groupId, row.input.clientId); check(owner);
    rmSync(`${filename(state, key)}.bak`, { force: true });
    rmSync(filename(state, key), { force: true });
    state.tombstones.delete(key);
  }
  async function finishTransfers(state: Account, owner: BotGroupOutboxOwner) {
    for (const row of [...state.rows.values()]) {
      const source = row.editSource;
      if (!source) continue;
      const key = keyOf(source.groupId, source.clientId);
      const old = state.rows.get(key);
      if (old && (!old.editHold || old.editHold.revision !== source.revision)) {
        state.blocked.add(queueKey(row)); continue;
      }
      // Never expose an already-consumed hold for a second edit, even if its cleanup fails.
      state.protected.add(key); state.claims.delete(key);
      try {
        if (old) await erase(state, key, owner);
        else {
          await deps.release(source.groupId, source.clientId); check(owner);
          rmSync(`${filename(state, key)}.bak`, { force: true });
          rmSync(filename(state, key), { force: true });
          state.tombstones.delete(key);
        }
        const cleaned = { ...row }; delete cleaned.editSource;
        await save(state, cleaned, owner);
      } catch { check(owner); /* Source relation stays durable; retry before any later cleanup. */ }
    }
  }
  function observeOwner(): void {
    const current = deps.currentOwner().dataOwnerId;
    if (lastOwner === current) return;
    // Only continuous same-account generation repair may retry a failed cancellation intent.
    // Durable holds/tombstones and Main network requests survive; uncommitted UI intentions do not.
    for (const previous of accounts.values()) { previous.claims.clear(); previous.intents.clear(); }
    lastOwner = current;
  }
  async function account(owner: BotGroupOutboxOwner): Promise<Account> {
    check(owner); observeOwner();
    let state = accounts.get(owner.dataOwnerId!);
    if (!state || state.root !== deps.ownerRoot()) {
      state = { ownerId: owner.dataOwnerId!, root: deps.ownerRoot(), revision: 0, loaded: false,
        rows: new Map(), claims: new Map(), high: new Map(), blocked: new Set(), migrationFailed: new Set(), protected: new Set(),
        operations: new Map(), intents: new Map(), tombstones: new Map(), inFlight: new Map(), settlements: new Map() };
      accounts.set(owner.dataOwnerId!, state);
    }
    if (state.loaded) return state;
    // Interrupted owner bootstrap is retried from disk, never from a partial directory index.
    state.rows.clear(); state.high.clear(); state.blocked.clear(); state.migrationFailed.clear(); state.operations.clear();
    let names: string[];
    try { names = await readdir(state.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    check(owner);
    const files = [...new Set(names.filter(name => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.bak$/, '')))].sort();
    for (let i = 0; i < files.length; i++) {
      if (i > 0 && i % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      check(owner);
      // An unreadable file may contain the durable queue head. Fail bootstrap so
      // a later command retries the complete index instead of letting a successor send.
      const raw = readAtomicFileSync(path.join(state.root, files[i]!));
      try {
        if (!raw || Buffer.byteLength(raw) > 8 * 1024 * 1024) continue;
        const value: unknown = JSON.parse(raw);
        if (value === null) continue;
        const parsed = entrySchema.safeParse(value);
        if (!parsed.success) {
          const identity = z.object({ input: z.object({ groupId: identifier, conversationKind: z.literal('direct').optional() }) }).safeParse(value);
          if (identity.success) state.blocked.add(JSON.stringify([identity.data.input.conversationKind ?? 'group', identity.data.input.groupId]));
          continue;
        }
        const row = parsed.data as BotGroupOutboxStoredEntry;
        if (`${hash(rowKey(row))}.json` !== files[i]) continue;
        state.rows.set(rowKey(row), row);
        if (row.coordinated) state.protected.add(rowKey(row));
        if (row.enqueueOperationId) state.operations.set(row.enqueueOperationId, acceptedOperation(row));
      } catch { /* One damaged row must not prevent recovery of unrelated rooms. */ }
      // Cold payload reads are batched; idle retries only use this in-memory index.
    }
    await finishTransfers(state, owner);
    const ordinals = new Map<string, Set<number>>();
    for (const row of state.rows.values()) {
      const queue = queueKey(row);
      if (row.coordinated && (!Number.isSafeInteger(row.entryRevision) || row.entryRevision! <= 0)) state.blocked.add(queue);
      if (row.queueOrdinal === undefined) continue;
      const ordinal = row.queueOrdinal;
      const seen = ordinals.get(queue) ?? new Set<number>(); ordinals.set(queue, seen);
      if (!Number.isSafeInteger(ordinal) || ordinal <= 0 || seen.has(ordinal)) state.blocked.add(queue);
      else { seen.add(ordinal); state.high.set(queue, Math.max(state.high.get(queue) ?? 0, ordinal)); }
    }
    const legacy = [...state.rows.values()].filter(row => row.queueOrdinal === undefined)
      .sort((a, b) => a.createdAt - b.createdAt || hash(rowKey(a)).localeCompare(hash(rowKey(b))));
    for (const row of legacy) {
      const queue = queueKey(row);
      if (state.blocked.has(queue) || state.migrationFailed.has(queue)) continue;
      const ordinal = (state.high.get(queue) ?? 0) + 1;
      if (!Number.isSafeInteger(ordinal)) { state.blocked.add(queue); continue; }
      try { await save(state, { ...row, queueOrdinal: ordinal }, owner); state.high.set(queue, ordinal); }
      catch { check(owner); state.migrationFailed.add(queue); }
    }
    state.loaded = true;
    return state;
  }
  const sourceConsumed = (state: Account, key: string) => [...state.rows.values()].some(row => row.editSource && keyOf(row.editSource.groupId, row.editSource.clientId) === key);
  const visible = (state: Account) => [...state.rows.values()].filter(row => !sourceConsumed(state, rowKey(row)))
    .sort((a, b) => (a.queueOrdinal ?? 0) - (b.queueOrdinal ?? 0)).map(clone);
  function result(state: Account, owner: BotGroupOutboxOwner, row?: BotGroupOutboxStoredEntry, execution?: BotGroupOutboxExecution): BotGroupOutboxCommandResult {
    return { ok: true, owner: { ...owner }, instanceId, revision: state.revision, entries: visible(state),
      removed: [...state.protected].filter(key => !state.rows.has(key) || sourceConsumed(state, key))
        .map(key => { const [groupId, clientId] = JSON.parse(key) as [string, string]; return { groupId, clientId }; }),
      ...(row ? { entry: clone(row) } : {}), ...(execution ? { execution: clone(execution) } : {}) };
  }
  function releaseSender(sender: Sender, keepInFlight = false) {
    for (const state of accounts.values()) {
      let changed = false;
      for (const [key, claim] of state.claims) if (claim.sender === sender && (!keepInFlight || !state.inFlight.has(key))) {
        state.claims.delete(key); changed = true;
      }
      // Main in-flight entries deliberately survive a renderer crash/navigation/destruction.
      if (changed) publish(state);
    }
  }
  function watch(sender: Sender) {
    if (watching.has(sender)) return;
    watching.add(sender);
    const release = () => releaseSender(sender);
    const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) release(); };
    sender.on('destroyed', release); sender.on('render-process-gone', release); sender.on('did-navigate', release);
    sender.on('did-start-navigation', navigate);
  }
  function validate(state: Account, sender: Sender, execution: BotGroupOutboxExecution) {
    const key = keyOf(execution.groupId, execution.clientId);
    const row = state.rows.get(key); const claim = state.claims.get(key);
    if (sender.isDestroyed() || execution.instanceId !== instanceId || execution.owner.dataOwnerId !== state.ownerId
      || !claim || claim.sender !== sender || claim.token !== execution.claimToken
      || claim.revision !== execution.entryRevision || row?.entryRevision !== execution.entryRevision
      || canonical(claim.owner) !== canonical(execution.owner) || row.editHold || state.intents.has(key) || sourceConsumed(state, key)) fail('STALE_EXECUTION');
    return row;
  }
  const executionOf = (row: BotGroupOutboxStoredEntry, claim: Claim): BotGroupOutboxExecution => ({
    owner: { ...claim.owner }, instanceId, groupId: row.input.groupId, clientId: row.input.clientId,
    entryRevision: row.entryRevision!, claimToken: claim.token,
  });
  const rowAt = (state: Account, id: { groupId: string; clientId: string; entryRevision: number }) => {
    const key = keyOf(id.groupId, id.clientId); const row = state.rows.get(key);
    if (!row || row.entryRevision !== id.entryRevision || sourceConsumed(state, key)) fail('STALE_ENTRY');
    return row;
  };
  async function flush(state: Account, owner: BotGroupOutboxOwner) {
    for (const queue of [...state.migrationFailed]) {
      const missing = [...state.rows.values()].filter(row => queueKey(row) === queue && row.queueOrdinal === undefined)
        .sort((a, b) => a.createdAt - b.createdAt || hash(rowKey(a)).localeCompare(hash(rowKey(b))));
      let complete = true;
      for (const row of missing) {
        const ordinal = (state.high.get(queue) ?? 0) + 1;
        if (!Number.isSafeInteger(ordinal)) { state.blocked.add(queue); complete = false; break; }
        try { await save(state, { ...row, queueOrdinal: ordinal }, owner); state.high.set(queue, ordinal); }
        catch { check(owner); complete = false; break; }
      }
      if (complete) state.migrationFailed.delete(queue);
    }
    for (const [key, row] of [...state.tombstones]) {
      try { await cleanupTombstone(state, key, row, owner); } catch { check(owner); }
    }
    await finishTransfers(state, owner);
    // Retry durable cancellation intentions before opening recovery, including same-owner repairs.
    for (const [key, intent] of [...state.intents]) {
      const row = state.rows.get(key);
      if (!row || row.entryRevision !== intent.revision) { state.intents.delete(key); continue; }
      try {
        if (intent.action === 'remove') await erase(state, key, owner);
        else {
          await save(state, { ...row, status: 'failed', retryable: false, entryRevision: intent.revision + 1,
            editHold: { operationId: intent.operationId!, revision: intent.revision + 1 } }, owner);
          state.claims.delete(key); state.intents.delete(key);
        }
      } catch { check(owner); /* Remains frozen and blocks the queue; caller must not report success. */ }
    }
    for (const [key, settlement] of [...state.settlements]) {
      const row = state.rows.get(key);
      if (!row || row.entryRevision !== settlement.entryRevision) continue;
      const settled: BotGroupOutboxStoredEntry = settlement.result.ok
        ? { ...row, status: 'sent', messageId: settlement.result.messageId, baseline: undefined }
        : { ...row, status: 'failed', retryable: !permanent.has(settlement.result.errorCode),
            quote: settlement.result.errorCode === 'QUOTE_UNAVAILABLE' ? null : row.quote,
            errorKey: settlement.result.errorCode === 'INVALID_PARAMS' && (row.prepared as unknown[] | undefined)?.length
              ? 'bots.groupChat.composer.attachmentsFailed'
              : botGroupErrorVariant(settlement.result.errorCode)
                ? `bots.groupChat.errors.${botGroupErrorVariant(settlement.result.errorCode)}` : 'bots.groupChat.composer.sendFailed', baseline: undefined };
      try {
        await save(state, settled, owner);
        state.settlements.delete(key); state.inFlight.delete(key); state.claims.delete(key);
      } catch { check(owner); /* Keep known result/in-flight gate until the commit succeeds. */ }
    }
  }
  async function command(sender: Sender, input: unknown): Promise<BotGroupOutboxCommandResult> {
    const request = parse(commandSchema, input) as BotGroupOutboxCommandRequest;
    return serial<BotGroupOutboxCommandResult>(async () => {
      check(request.owner);
      if (sender.isDestroyed()) fail('WINDOW_GONE');
      enabled.add(sender); watch(sender);
      const state = await account(request.owner);
      await flush(state, request.owner);
      // Opening the new protocol adopts legacy records before permitting any old put/send.
      for (const row of [...state.rows.values()]) {
        if (row.coordinated) continue;
        const queue = queueKey(row);
        if (state.blocked.has(queue) || state.migrationFailed.has(queue)) continue;
        const ordinal = row.queueOrdinal ?? (state.high.get(queue) ?? 0) + 1;
        if (!Number.isSafeInteger(ordinal) || ordinal <= 0) { state.blocked.add(queue); continue; }
        await save(state, { ...row, coordinated: true, entryRevision: row.editHold?.revision ?? 1, queueOrdinal: ordinal }, request.owner);
        state.high.set(queue, Math.max(state.high.get(queue) ?? 0, ordinal));
      }
      const owner = request.owner;
      if (request.action === 'snapshot') {
        if (request.known?.instanceId === instanceId && request.known.revision === state.revision) {
          return { ok: true, owner: { ...owner }, instanceId, revision: state.revision, entries: [], unchanged: true };
        }
        return result(state, owner);
      }
      if (request.action === 'release') { releaseSender(sender, true); return result(state, owner); }
      if (request.action === 'enqueue') {
        const original = parse(entrySchema, request.entry) as BotGroupOutboxStoredEntry;
        if (original.input.attachments !== undefined) fail('INVALID_ORIGINAL_INPUT');
        const key = rowKey(original); const businessSignature = signature(original);
        const previous = state.operations.get(request.enqueueOperationId);
        if (previous) {
          if (previous.key !== key || previous.signatureHash !== hash(businessSignature)
            || canonical(previous.source) !== canonical(request.editSource)) fail('OPERATION_CONFLICT');
          return { ...result(state, owner, state.rows.get(key)), accepted: true };
        }
        let source: BotGroupOutboxStoredEntry | undefined;
        if (request.editSource) {
          const sourceKey = keyOf(request.editSource.groupId, request.editSource.clientId);
          source = state.rows.get(sourceKey);
          if (!source?.editHold || source.editHold.revision !== request.editSource.revision
            || sourceConsumed(state, sourceKey) || state.intents.has(sourceKey)) fail('SOURCE_CONSUMED');
          if (source.input.groupId !== original.input.groupId || queueKey(source) !== queueKey(original)) fail('SOURCE_CONFLICT');
          if (source.editSource) fail('TRANSFER_PENDING');
          if ((key === sourceKey) !== (signature(source) === businessSignature)) fail('CLIENT_ID_CONFLICT');
        }
        if (state.rows.has(key) && (!source || rowKey(source) !== key)) fail('ENTRY_EXISTS');
        if (state.protected.has(key) && !source) fail('RETIRED_ENTRY');
        const queue = queueKey(original);
        if (state.blocked.has(queue) || state.migrationFailed.has(queue)) fail('QUEUE_INVALID');
        const ordinal = (state.high.get(queue) ?? 0) + 1;
        if (!Number.isSafeInteger(ordinal)) fail('QUEUE_INVALID');
        state.high.set(queue, ordinal); // Failed commits may leave gaps, never reorder committed rows.
        const row: BotGroupOutboxStoredEntry = { ...original, coordinated: true, entryRevision: (source?.entryRevision ?? 0) + 1,
          queueOrdinal: ordinal, status: 'sending', retryable: true, enqueueOperationId: request.enqueueOperationId,
          businessSignature, enqueueSource: request.editSource, editSource: source && rowKey(source) !== key ? request.editSource : undefined };
        for (const field of ['editHold', 'prepared', 'messageId', 'errorKey', 'receiptTick', 'baseline']) delete row[field];
        await save(state, row, owner);
        state.claims.delete(key);
        if (source) state.claims.delete(rowKey(source));
        if (row.editSource) await finishTransfers(state, owner);
        return { ...result(state, owner, state.rows.get(key)), accepted: true };
      }
      if (request.action === 'claim') {
        const key = keyOf(request.groupId, request.clientId); let row = state.rows.get(key);
        if (request.entryRevision !== undefined && request.entryRevision !== row?.entryRevision) fail('STALE_ENTRY');
        if (!row || row.editHold || row.status === 'sent' || row.retryable === false || state.intents.has(key)
          || state.inFlight.has(key) || sourceConsumed(state, key)) fail('NOT_CLAIMABLE');
        if (state.blocked.has(queueKey(row)) || state.migrationFailed.has(queueKey(row))) fail('QUEUE_INVALID');
        let claim = state.claims.get(key);
        if (claim && claim.sender !== sender) fail('ALREADY_CLAIMED');
        if (!row.coordinated) {
          row = { ...row, coordinated: true, entryRevision: 1 };
          await save(state, row, owner);
        }
        if (!claim) {
          claim = { sender, token: randomUUID(), revision: row.entryRevision!, owner: { ...owner } };
          state.claims.set(key, claim); publish(state);
        } else claim.owner = { ...owner }; // Same account generation repair does not steal a living claim.
        return result(state, owner, row, executionOf(row, claim));
      }
      if (request.action === 'prepared' || request.action === 'fail') {
        const row = validate(state, sender, request.execution); const key = rowKey(row);
        if (state.inFlight.has(key) || row.status === 'sent') fail('BUSY');
        if (request.action === 'prepared') {
          if (row.prepared && canonical(row.prepared) !== canonical(request.prepared)) fail('PREPARED_CONFLICT');
          await save(state, { ...row, prepared: clone(request.prepared), attachments: clone(request.attachments) }, owner);
        } else await save(state, { ...row, status: 'failed', errorKey: request.errorKey, retryable: request.retryable }, owner);
        return result(state, owner, state.rows.get(key), request.execution);
      }
      const existing = state.rows.get(keyOf(request.groupId, request.clientId));
      if (request.action === 'remove' && state.protected.has(keyOf(request.groupId, request.clientId)) && !existing) return result(state, owner);
      if (request.action === 'edit' && existing?.editHold?.operationId === request.operationId
        && (request.entryRevision === existing.editHold.revision || request.entryRevision + 1 === existing.editHold.revision)) {
        return result(state, owner, existing);
      }
      const row = rowAt(state, request); const key = rowKey(row);
      if (request.action === 'retry') {
        if (row.status !== 'failed' || row.retryable === false || row.editHold || state.intents.has(key)) fail('NOT_RETRYABLE');
        await save(state, { ...row, status: 'sending', errorKey: undefined }, owner);
        return result(state, owner, state.rows.get(key));
      }
      if (request.action === 'edit' && row.editHold) {
        if (row.editHold.operationId !== request.operationId) fail('EDIT_CONFLICT');
        return result(state, owner, row);
      }
      if (row.editSource) fail('TRANSFER_PENDING');
      if (state.inFlight.has(key) || row.status === 'sent' && request.action === 'edit') fail('BUSY');
      state.intents.set(key, { action: request.action, revision: row.entryRevision!,
        ...(request.action === 'edit' ? { operationId: request.operationId } : {}) });
      state.claims.delete(key);
      if (request.action === 'remove') await erase(state, key, owner);
      else {
        await save(state, { ...row, status: 'failed', retryable: false, entryRevision: row.entryRevision! + 1,
          editHold: { operationId: request.operationId, revision: row.entryRevision! + 1 } }, owner);
        state.intents.delete(key);
      }
      return result(state, owner, state.rows.get(key));
    }).catch(storageFailure);
  }
  async function send(sender: Sender, input: unknown, executionInput: unknown,
    service: (input: BotGroupSendInput) => Promise<BotGroupSendResult>): Promise<BotGroupSendResult> {
    // Legacy callers that do not use this outbox keep their original path, but cannot touch a coordinated identity.
    const admitted = await serial(async () => {
      const owner = deps.currentOwner(); check(owner);
      const state = await account(owner);
      if (executionInput === undefined || executionInput === null) {
        const id = z.object(identitySchema).safeParse(input);
        if (enabled.has(sender) || id.success && state.protected.has(keyOf(id.data.groupId, id.data.clientId))) fail('EXECUTION_REQUIRED');
        return { legacy: true as const, owner: { ...owner } };
      }
      const execution = parse(executionSchema, executionInput) as BotGroupOutboxExecution;
      if (execution.owner.generation !== owner.generation) fail('OWNER_CHANGED');
      await flush(state, owner);
      const row = validate(state, sender, execution); const key = rowKey(row); const queue = queueKey(row);
      if (state.blocked.has(queue) || state.migrationFailed.has(queue)) fail('QUEUE_INVALID');
      if (state.inFlight.has(key) || row.status === 'sent' || row.retryable === false) fail('BUSY');
      const head = [...state.rows.values()].filter(candidate => queueKey(candidate) === queue && candidate.status !== 'sent'
        && !candidate.editHold && !sourceConsumed(state, rowKey(candidate)))
        .sort((a, b) => a.queueOrdinal! - b.queueOrdinal!)[0];
      if (head !== row || [...state.inFlight.keys()].some(id => {
        const other = state.rows.get(id); return other && queueKey(other) === queue;
      })) fail('WAITING_FOR_HEAD');
      const files = (row.prepared ?? []) as Array<Record<string, unknown>>;
      if ((row.files as unknown[]).length && !row.prepared) fail('NOT_PREPARED');
      // Match toBotGroupAttachmentInputs(serializeAttachedFiles): originalName defaults to name,
      // and a recovered already-annotated base is still an annotated attachment.
      const attachments = files.map(file => ({ ...Object.fromEntries(['id', 'name', 'path', 'ext', 'size', 'category', 'mimeType']
        .filter(field => file[field] !== undefined).map(field => [field, file[field]])),
        ...(file.url ? { url: file.url } : {}),
        ...(file.originalName ?? file.name ? { originalName: file.originalName ?? file.name } : {}),
        ...(file.annotated || file.baseAnnotated ? { annotated: true } : {}) }));
      const savedInput = { ...row.input, ...(attachments.length ? { attachments } : {}) } as unknown as BotGroupSendInput;
      if (canonical(input) !== canonical(savedInput)) fail('INPUT_CONFLICT');
      await save(state, { ...row, status: 'sending' }, owner);
      state.inFlight.set(key, row.entryRevision!);
      return { legacy: false as const, state, key, revision: row.entryRevision!, savedInput, owner: { ...owner } };
    }).catch(storageFailure);
    if (admitted.legacy) { check(admitted.owner); return service(input as BotGroupSendInput); }
    let outcome: BotGroupSendResult;
    try {
      // Admission awaited a serial Promise. Fence again at the actual service edge: a queued
      // account commit must not hand this saved input to the next account's live service holder.
      check(admitted.owner);
      outcome = await service(admitted.savedInput);
    }
    catch { outcome = { ok: false, errorCode: 'INTERNAL', message: 'Send result unavailable' }; }
    await serial(async () => {
      const { state, key, revision } = admitted;
      state.settlements.set(key, { entryRevision: revision, result: outcome });
      const owner = deps.currentOwner();
      if (!deps.boundaryPending() && owner.dataOwnerId === state.ownerId) await flush(state, owner);
    }).catch(storageFailure);
    return outcome;
  }
  async function access(input: unknown): Promise<BotGroupOutboxStoredEntry[]> {
    const request = parse(legacySchema, input);
    return serial(async () => {
      const state = await account(request.owner);
      if (request.action === 'list') return visible(state);
      const id = request.action === 'put' ? request.entry.input : request;
      const key = keyOf(id.groupId, id.clientId);
      if (state.protected.has(key)) fail('EXECUTION_REQUIRED');
      if (request.action === 'put') {
        // Metadata is Main-owned; old uncoordinated clients cannot mint an execution generation.
        const row = { ...request.entry } as BotGroupOutboxStoredEntry;
        for (const field of ['coordinated', 'entryRevision', 'queueOrdinal', 'editHold', 'editSource', 'enqueueSource', 'enqueueOperationId', 'businessSignature']) delete row[field];
        await save(state, row, request.owner);
      } else await erase(state, key, request.owner);
      return [];
    }).catch(storageFailure);
  }
  return { command, send, access, releaseSender, observeOwner, instanceId };
}

async function retainMedia(entry: BotGroupOutboxStoredEntry, check: () => void): Promise<() => Promise<void>> {
  const refId = `outbox:${hash(rowKey(entry))}`;
  const db = getDbClient().drizzle;
  const added: string[] = [];
  const rollback = async () => { await Promise.all(added.map(id => ledger.removeRefById(id, db).catch(() => undefined))); };
  try {
    const files = [...entry.files as Array<{ url?: string; annotationSourceUrl?: string }>,
      ...(entry.prepared as Array<{ url?: string; annotationSourceUrl?: string }> | undefined ?? [])];
    for (const url of new Set(files.flatMap(file => [file.url, file.annotationSourceUrl]))) {
      const blob = url && parseBlobUrl(url);
      if (!blob) continue;
      check();
      if (!await ledger.hasRef({ hash: blob.hash, refKind: 'bot-group-attachment', refId }, db)) {
        await ledger.pinBlob(blob.hash, db); check();
        added.push(await ledger.addRef({ hash: blob.hash, refKind: 'bot-group-attachment', refId, originKind: 'user' }, db));
      }
    }
    check(); return rollback;
  } catch (error) { await rollback(); throw error; }
}
let publisher: ((event: BotGroupOutboxChanged) => void) | undefined;
const storage = createBotGroupOutboxStorage({
  currentOwner: getActiveAppSession, boundaryPending: isAppSessionBoundaryPending,
  ownerRoot: () => ownerScopedUserDataPath('bot-group-outbox'), retain: retainMedia,
  release: async (groupId, clientId) => { await ledger.removeRefs({ refKind: 'bot-group-attachment',
    refId: `outbox:${hash(keyOf(groupId, clientId))}` }, getDbClient().drizzle); },
  publish: event => publisher?.(event),
});
// Session invalidation is announced before commit. Observe after the synchronous commit so a
// real switch is noticed even if the intervening account never opens an outbox window.
onAppSessionInvalidated(() => queueMicrotask(storage.observeOwner));
export function setBotGroupOutboxPublisher(publish: (event: BotGroupOutboxChanged) => void): void { publisher = publish; }
export const accessBotGroupOutbox = storage.access;
export const commandBotGroupOutbox = storage.command;
export const sendCoordinatedBotGroupMessage = storage.send;
