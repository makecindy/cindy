/** Native history transport. Only the authenticated same-account host may call this API.
 * Copies are streamed in bounded chunks; source records are never modified or removed. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';

export const NATIVE_HISTORY_CHUNK_BYTES = 512 * 1024;
export const NATIVE_HISTORY_BACKUP_BYTES = 16 * 1024 * 1024;
export const NATIVE_HISTORY_BACKUP_CHUNK_BYTES = 128 * 1024;
const TTL_MS = 10 * 60_000;
type Kind = 'claude-code' | 'codex' | 'pi';
export type NativeHistoryPrefix = Pick<NativeHistoryManifest, 'bytes' | 'sha256'>;
export const NATIVE_HISTORY_CHECKPOINT = 'nativeHistoryCheckpoint';
export interface NativeHistoryCheckpointSnapshot {
  prefix?: NativeHistoryPrefix;
  assistantSha256: string;
  assertUnchanged(): void;
}
export interface NativeHistoryManifest {
  kind: Kind;
  nativeId: string;
  bytes: number;
  sha256: string;
  state?: {
    threads: Array<Record<string, unknown>>;
    threadDynamicTools: Array<Record<string, unknown>>;
    threadSpawnEdges: Array<Record<string, unknown>>;
  };
}
export type NativeHistoryCommand =
  | { action: 'export'; kind: Kind; nativeId: string }
  | { action: 'checkpoint-export'; runId: string; checkpoint: string; prefix?: NativeHistoryPrefix }
  | { action: 'import'; manifest: NativeHistoryManifest }
  | { action: 'read'; id: string; offset: number; limit?: number; backup?: true }
  | { action: 'write'; id: string; offset: number; data: string }
  | { action: 'restore'; id: string }
  | { action: 'release'; id: string; backup?: true };

function invalid(): never { throw new Error('REMOTE_AGENT_INVALID'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) invalid();
  return value as string;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function kind(value: unknown): Kind {
  if (value !== 'claude-code' && value !== 'codex' && value !== 'pi') invalid();
  return value as Kind;
}
export function parseNativeHistoryManifest(value: unknown): NativeHistoryManifest {
  const v = record(value);
  const result: NativeHistoryManifest = {
    kind: kind(v.kind), nativeId: text(v.nativeId), bytes: count(v.bytes), sha256: text(v.sha256, 64),
  };
  if (!result.bytes || !/^[a-f0-9]{64}$/.test(result.sha256)) invalid();
  if (result.kind !== 'pi' && !/^[a-f0-9-]{36}$/i.test(result.nativeId)) invalid();
  if (v.state !== undefined) {
    const state = record(v.state);
    if (result.kind !== 'codex' || JSON.stringify(state).length > 512 * 1024) invalid();
    const rows = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 4096) invalid();
      return (value as unknown[]).map(record);
    };
    result.state = { threads: rows(state.threads), threadDynamicTools: rows(state.threadDynamicTools), threadSpawnEdges: rows(state.threadSpawnEdges) };
    if (result.state.threads.some(row => row.id !== result.nativeId)
      || result.state.threadDynamicTools.some(row => row.thread_id !== result.nativeId)
      || result.state.threadSpawnEdges.some(row => row.parent_thread_id !== result.nativeId && row.child_thread_id !== result.nativeId)) invalid();
  }
  return result;
}
export function parseNativeHistoryCommand(value: unknown): NativeHistoryCommand {
  const v = record(value);
  if (v.action === 'export') return { action: 'export', kind: kind(v.kind), nativeId: text(v.nativeId) };
  if (v.action === 'checkpoint-export') {
    const runId = text(v.runId, 128);
    const checkpoint = text(v.checkpoint, 36);
    if (!/^[a-f0-9-]{36}$/.test(checkpoint)) invalid();
    if (v.prefix === undefined) return { action: v.action, runId, checkpoint };
    const prefix = record(v.prefix);
    const bytes = count(prefix.bytes);
    const sha256 = text(prefix.sha256, 64);
    if (!bytes || bytes > NATIVE_HISTORY_BACKUP_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) invalid();
    return { action: v.action, runId, checkpoint, prefix: { bytes, sha256 } };
  }
  if (v.action === 'import') return { action: 'import', manifest: parseNativeHistoryManifest(v.manifest) };
  const id = text(v.id, 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) invalid();
  if (v.action === 'release') return { action: v.action, id, ...(v.backup === true ? { backup: true } : {}) };
  if (v.action === 'restore') return { action: v.action, id };
  const offset = count(v.offset);
  if (v.action === 'read') {
    const limit = v.limit === undefined ? undefined : count(v.limit);
    if (limit !== undefined && (!limit || limit > NATIVE_HISTORY_CHUNK_BYTES)) invalid();
    return { action: 'read', id, offset, ...(limit === undefined ? {} : { limit }),
      ...(v.backup === true ? { backup: true } : {}) };
  }
  if (v.action === 'write') {
    const data = text(v.data, Math.ceil(NATIVE_HISTORY_CHUNK_BYTES / 3) * 4);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || Buffer.from(data, 'base64').toString('base64') !== data) invalid();
    return { action: 'write', id, offset, data };
  }
  return invalid();
}

export async function nativeHistoryDigest(file: string, range?: { start?: number; end?: number }): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, range)) hash.update(chunk);
  return hash.digest('hex');
}

/** Reject a live Pi file which has already started recording a subsequent turn. */
async function validatePiCheckpoint(file: string, assistantSha256: string): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header = false;
  let lastMessage: unknown;
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line) as { type?: string; message?: unknown };
      if (!header) {
        if (entry.type !== 'session') throw new Error('NATIVE_HISTORY_INCOMPLETE');
        header = true;
      } else if (entry.type === 'message') {
        lastMessage = entry.message;
      }
    }
  } catch {
    throw new Error('NATIVE_HISTORY_INCOMPLETE');
  } finally { stream.destroy(); }
  const assistant = lastMessage as { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] } | undefined;
  const text = Array.isArray(assistant?.content) ? assistant.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => stripInternalWebCitations(block.text!)).filter(Boolean).join('\n\n') : '';
  if (assistant?.role !== 'assistant' || assistant.stopReason !== 'stop'
    || createHash('sha256').update(text).digest('hex') !== assistantSha256) throw new Error('NATIVE_HISTORY_INCOMPLETE');
}

export interface NativeHistoryStorage {
  locate(kind: Kind, nativeId: string, checkpoint?: boolean): Promise<{ file: string; state?: NativeHistoryManifest['state'] }>;
  restore(file: string, manifest: NativeHistoryManifest, workingDir: string, assertCurrent: () => void): Promise<string>;
}

/** Transfer handles are bound to the owner generation, device and task by the caller. */
export function createNativeHistoryTransfer(root: string, storage: NativeHistoryStorage) {
  let creating = 0;
  const transfers = new Map<string, {
    scope: string; file: string; manifest: NativeHistoryManifest; direction: 'export' | 'import';
    offset: number; touched: number; busy: boolean; assertOwner: () => void;
  }>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  const remove = async (id: string) => {
    clearTimeout(expiry.get(id));
    expiry.delete(id);
    const entry = transfers.get(id);
    transfers.delete(id);
    if (entry) await fs.rm(path.dirname(entry.file), { recursive: true, force: true });
  };
  const renew = (id: string) => {
    clearTimeout(expiry.get(id));
    const timer = setTimeout(() => {
      if (transfers.get(id)?.busy) renew(id);
      else void remove(id).catch(() => {});
    }, TTL_MS);
    timer.unref?.();
    expiry.set(id, timer);
  };
  return async (scope: string, raw: unknown, workingDir: string, assertCurrent: () => void,
    checkpoint?: NativeHistoryCheckpointSnapshot): Promise<unknown> => {
    const command = parseNativeHistoryCommand(raw);
    if (command.action === 'checkpoint-export') invalid();
    assertCurrent();
    for (const [id, entry] of transfers) {
      if (!entry.busy && Date.now() - entry.touched > TTL_MS) await remove(id);
    }
    if (command.action === 'export' || command.action === 'import') {
      if (transfers.size + creating >= 16) throw new Error('REMOTE_AGENT_BUSY');
      creating += 1;
      let dir: string | undefined;
      try {
        const id = randomUUID();
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        dir = await fs.mkdtemp(path.join(root, 'history-'));
        const file = path.join(dir, 'history.jsonl');
        let manifest: NativeHistoryManifest;
        if (command.action === 'export') {
          const source = await storage.locate(command.kind, command.nativeId, checkpoint ? true : undefined);
          const before = await fs.stat(source.file);
          if (!before.isFile()) invalid();
          if (checkpoint) {
            if (!before.size || before.size > NATIVE_HISTORY_BACKUP_BYTES) throw new Error('NATIVE_HISTORY_TOO_LARGE');
            checkpoint.assertUnchanged();
            await pipeline(createReadStream(source.file, { end: before.size - 1 }),
              createWriteStream(file, { flags: 'wx', mode: 0o600 }));
          } else {
            await fs.copyFile(source.file, file);
            await fs.chmod(file, 0o600);
          }
          const after = await fs.stat(source.file);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('NATIVE_HISTORY_CHANGED');
          if (checkpoint) {
            const handle = await fs.open(file, 'r');
            try {
              const byte = Buffer.alloc(1);
              if ((await handle.read(byte, 0, 1, before.size - 1)).bytesRead !== 1 || byte[0] !== 10) {
                throw new Error('NATIVE_HISTORY_INCOMPLETE');
              }
            } finally { await handle.close(); }
            checkpoint.assertUnchanged();
            await validatePiCheckpoint(file, checkpoint.assistantSha256);
          }
          manifest = parseNativeHistoryManifest({ kind: command.kind, nativeId: command.nativeId,
            bytes: before.size, sha256: await nativeHistoryDigest(file), ...(source.state ? { state: source.state } : {}) });
        } else {
          manifest = command.manifest;
          await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
        }
        const prefix = checkpoint?.prefix;
        // Only negotiate a tail when the source actually contains the exact saved prefix.
        const offset = prefix && prefix.bytes <= manifest.bytes
          && (prefix.bytes === manifest.bytes ? manifest.sha256 : await nativeHistoryDigest(file, { end: prefix.bytes - 1 })) === prefix.sha256
          ? prefix.bytes : 0;
        assertCurrent();
        transfers.set(id, { scope, file, manifest, direction: command.action, offset: 0, touched: Date.now(), busy: false, assertOwner: assertCurrent });
        renew(id);
        if (checkpoint) return { id, manifest, offset };
        return { id, manifest };
      } catch (error) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
        throw error;
      } finally {
        creating -= 1;
      }
    }
    const entry = transfers.get(command.id);
    if (!entry || entry.scope !== scope) throw new Error('REMOTE_AGENT_NOT_FOUND');
    entry.assertOwner();
    if (entry.busy) throw new Error('REMOTE_AGENT_BUSY');
    entry.busy = true;
    entry.touched = Date.now();
    renew(command.id);
    try {
      if (command.action === 'release') { await remove(command.id); return { ok: true }; }
      if (command.action === 'read') {
        if (entry.direction !== 'export' || command.offset >= entry.manifest.bytes) invalid();
        const handle = await fs.open(entry.file, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(command.limit ?? NATIVE_HISTORY_CHUNK_BYTES, entry.manifest.bytes - command.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, command.offset);
          assertCurrent();
          return { data: buffer.subarray(0, bytesRead).toString('base64') };
        } finally { await handle.close(); }
      }
      if (entry.direction !== 'import') invalid();
      if (command.action === 'write') {
        const bytes = Buffer.from(command.data, 'base64');
        if (command.offset !== entry.offset || bytes.length > NATIVE_HISTORY_CHUNK_BYTES || entry.offset + bytes.length > entry.manifest.bytes) invalid();
        await fs.appendFile(entry.file, bytes);
        entry.offset += bytes.length;
        assertCurrent();
        return { offset: entry.offset };
      }
      if (entry.offset !== entry.manifest.bytes || await nativeHistoryDigest(entry.file) !== entry.manifest.sha256) throw new Error('NATIVE_HISTORY_INCOMPLETE');
      assertCurrent();
      const nativeId = await storage.restore(entry.file, entry.manifest, workingDir, assertCurrent);
      assertCurrent();
      await remove(command.id);
      return { nativeId };
    } finally { entry.busy = false; }
  };
}

export type NativeHistoryEndpoint = (command: NativeHistoryCommand) => Promise<unknown>;
export async function transferNativeHistory(source: NativeHistoryEndpoint, target: NativeHistoryEndpoint,
  kind: Kind, nativeId: string, assertCurrent: () => void): Promise<string> {
  let exported: string | undefined;
  let imported: string | undefined;
  try {
    assertCurrent();
    const snapshot = record(await source({ action: 'export', kind, nativeId }));
    exported = text(snapshot.id, 36);
    const manifest = parseNativeHistoryManifest(snapshot.manifest);
    if (manifest.kind !== kind || manifest.nativeId !== nativeId) invalid();
    assertCurrent();
    imported = text(record(await target({ action: 'import', manifest })).id, 36);
    for (let offset = 0; offset < manifest.bytes;) {
      assertCurrent();
      const data = text(record(await source({ action: 'read', id: exported, offset })).data, Math.ceil(NATIVE_HISTORY_CHUNK_BYTES / 3) * 4);
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > NATIVE_HISTORY_CHUNK_BYTES || offset + bytes.length > manifest.bytes) invalid();
      const receipt = record(await target({ action: 'write', id: imported, offset, data }));
      offset += bytes.length;
      if (receipt.offset !== offset) invalid();
    }
    assertCurrent();
    const restored = text(record(await target({ action: 'restore', id: imported })).nativeId);
    assertCurrent();
    return restored;
  } finally {
    await Promise.allSettled([
      ...(exported ? [source({ action: 'release', id: exported })] : []),
      ...(imported ? [target({ action: 'release', id: imported })] : []),
    ]);
  }
}
