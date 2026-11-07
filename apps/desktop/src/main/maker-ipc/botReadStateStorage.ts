import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  botReadIdentityKey,
  type BotReadIdentity,
  type BotReadOwner,
  type BotReadPosition,
  type BotReadStateChanged,
  type BotReadStateResult,
} from '../../shared/botReadStateStorage.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const MAX_RECORD_BYTES = 16 * 1024;
const PAGE_BYTES = 256 * 1024;
const identifier = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative().safe();
const identitySchema = z.union([
  z.object({ kind: z.enum(['bot', 'group', 'thread']), id: identifier }).strict(),
  z.object({ kind: z.literal('remote-bot'), deviceId: identifier, botId: identifier }).strict(),
]);
const positionSchema = z.object({
  identity: identitySchema,
  initialAt: timestamp.optional(),
  ackAt: timestamp.optional(),
  legacyFloor: timestamp.optional(),
}).strict().refine(value => value.initialAt !== undefined || value.ackAt !== undefined || value.legacyFloor !== undefined);
const recordSchema = z.object({ schemaVersion: z.literal(1), position: positionSchema }).strict();
const ownerSchema = z.object({ dataOwnerId: identifier, generation: timestamp }).strict();
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), owner: ownerSchema, cursor: z.string().max(1024).optional() }).strict(),
  z.object({ action: z.literal('merge'), owner: ownerSchema, positions: z.array(positionSchema).min(1).max(128) }).strict(),
]);
const cursorSchema = z.object({
  instanceId: z.string(), generation: timestamp, revision: timestamp, after: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const digest = (identity: BotReadIdentity) => createHash('sha256').update(botReadIdentityKey(identity)).digest('hex');
const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve));

interface Partition {
  root: string;
  revision: number;
  records: Map<string, BotReadPosition | null>;
  names: Set<string> | null;
}

/** Dependencies are owner-scoped Main capabilities, not renderer-provided paths or account authority. */
export interface BotReadStateStorageDependencies {
  currentOwner: () => { dataOwnerId: string | null; generation: number };
  boundaryPending: () => boolean;
  ownerRoot: () => string;
  /** The adapter delivers invalidations only to this owner's trusted complete app windows. */
  publish?: (event: BotReadStateChanged) => void;
}

/**
 * One Main writer merges per-identity facts before acknowledging them. No full-table writes,
 * pruning by roster membership, or localStorage conflict-resolution protocol lives here.
 */
export function createBotReadStateStorage(deps: BotReadStateStorageDependencies) {
  const instanceId = randomUUID();
  const partitions = new Map<string, Partition>();
  let chain: Promise<unknown> = Promise.resolve();

  function checkOwner(owner: BotReadOwner): void {
    const active = deps.currentOwner();
    if (deps.boundaryPending() || active.dataOwnerId !== owner.dataOwnerId || active.generation !== owner.generation) {
      throwIpcError('PRECONDITION_FAILED', 'BOT_READ_OWNER_CHANGED');
    }
  }

  function partitionFor(owner: BotReadOwner): Partition {
    checkOwner(owner);
    const root = deps.ownerRoot();
    const key = JSON.stringify([owner.dataOwnerId, owner.generation, root]);
    let partition = partitions.get(key);
    if (!partition) {
      // No work may retain a previous account's in-memory projection across a boundary.
      partitions.clear();
      partition = { root, revision: 0, records: new Map(), names: null };
      partitions.set(key, partition);
    }
    return partition;
  }

  function read(partition: Partition, name: string): BotReadPosition | null {
    if (partition.records.has(name)) return partition.records.get(name)!;
    let position: BotReadPosition | null;
    try {
      const raw = readAtomicFileSync(path.join(partition.root, `${name}.json`));
      if (raw === null) position = null;
      else {
        if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) throw new Error('record too large');
        position = recordSchema.parse(JSON.parse(raw)).position;
        if (digest(position.identity) !== name) throw new Error('identity mismatch');
      }
    } catch {
      // An unreadable/invalid record is not an empty position that a later seed may overwrite.
      throwIpcError('INTERNAL', 'BOT_READ_STATE_READ_FAILED');
    }
    partition.records.set(name, position);
    return position;
  }

  function namesFor(partition: Partition): Set<string> {
    if (partition.names) return partition.names;
    let names: string[];
    try { names = readdirSync(partition.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throwIpcError('INTERNAL', 'BOT_READ_STATE_READ_FAILED');
      names = [];
    }
    partition.names = new Set(names.filter(name => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(name))
      .map(name => name.replace(/\.json(?:\.bak)?$/, '')));
    // Writes before the first snapshot must not disappear from that snapshot's index.
    for (const [name, value] of partition.records) if (value) partition.names.add(name);
    return partition.names;
  }

  function merge(partition: Partition, owner: BotReadOwner, incoming: BotReadPosition): BotReadPosition {
    checkOwner(owner);
    const name = digest(incoming.identity);
    const previous = read(partition, name);
    const next: BotReadPosition = { ...(previous ?? { identity: incoming.identity }) };
    if (incoming.initialAt !== undefined) next.initialAt = Math.min(previous?.initialAt ?? Infinity, incoming.initialAt);
    if (incoming.ackAt !== undefined) next.ackAt = Math.max(previous?.ackAt ?? 0, incoming.ackAt);
    if (incoming.legacyFloor !== undefined) next.legacyFloor = Math.max(previous?.legacyFloor ?? 0, incoming.legacyFloor);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    const raw = JSON.stringify({ schemaVersion: 1, position: next });
    if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) throwIpcError('INVALID_PARAMS', 'BOT_READ_RECORD_TOO_LARGE');
    try { atomicWriteFileSync(path.join(partition.root, `${name}.json`), raw); }
    catch { throwIpcError('INTERNAL', 'BOT_READ_STATE_WRITE_FAILED'); }
    // Only the committed file becomes a shared fact. A failed write leaves cache/revision unchanged.
    partition.records.set(name, next);
    partition.names?.add(name);
    partition.revision += 1;
    try { deps.publish?.({ owner: { ...owner }, instanceId, revision: partition.revision }); }
    catch { /* Notification loss must not turn a durable commit into a reported save failure. */ }
    return next;
  }

  async function run(input: unknown): Promise<BotReadStateResult> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throwIpcError('INVALID_PARAMS', 'INVALID_BOT_READ_STATE_REQUEST');
    const request = parsed.data;
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > PAGE_BYTES) {
      throwIpcError('INVALID_PARAMS', 'BOT_READ_REQUEST_TOO_LARGE');
    }
    const { owner } = request;
    const partition = partitionFor(owner);
    const version = () => ({ owner: { ...owner }, instanceId, revision: partition.revision });
    if (request.action === 'merge') {
      const positions: BotReadPosition[] = [];
      for (const incoming of request.positions) {
        positions.push(merge(partition, owner, incoming));
        // No network await is held in the serial lane; yield large local batches to the main loop.
        if (positions.length % 32 === 0) { await yieldToMain(); checkOwner(owner); }
      }
      return { ...version(), positions };
    }
    let after = '';
    if (request.cursor !== undefined) {
      let cursor: z.infer<typeof cursorSchema>;
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))); }
      catch { throwIpcError('INVALID_PARAMS', 'INVALID_BOT_READ_CURSOR'); }
      if (cursor.instanceId !== instanceId || cursor.generation !== owner.generation || cursor.revision !== partition.revision) {
        throwIpcError('PRECONDITION_FAILED', 'BOT_READ_SNAPSHOT_STALE');
      }
      after = cursor.after;
    }
    const names = [...namesFor(partition)].sort().filter(name => name > after);
    const positions: BotReadPosition[] = [];
    // Reserve room for version/cursor. Each record is bounded independently of account size.
    let bytes = Buffer.byteLength(JSON.stringify({ ...version(), positions }), 'utf8') + 1024;
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      const position = read(partition, name);
      const size = position ? Buffer.byteLength(JSON.stringify(position), 'utf8') + 1 : 0;
      if (bytes + size > PAGE_BYTES) {
        return { ...version(), positions, nextCursor: Buffer.from(JSON.stringify({
          instanceId, generation: owner.generation, revision: partition.revision, after: names[index - 1]!,
        })).toString('base64url') };
      }
      if (position) { positions.push(position); bytes += size; }
      if ((index + 1) % 32 === 0) { await yieldToMain(); checkOwner(owner); }
    }
    checkOwner(owner);
    return { ...version(), positions };
  }

  return {
    /** Queue before parsing/capturing any owner path; queued old-account commands still fail closed. */
    access(input: unknown): Promise<BotReadStateResult> {
      const operation = chain.then(() => run(input));
      chain = operation.catch(() => undefined);
      return operation;
    },
  };
}
