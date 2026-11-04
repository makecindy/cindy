/** Native history transport. Only the authenticated same-account host may call this API.
 * Copies are streamed in bounded chunks; source records are never modified or removed. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

export const NATIVE_HISTORY_CHUNK_BYTES = 512 * 1024;
const TTL_MS = 10 * 60_000;
type Kind = 'claude-code' | 'codex' | 'pi' | 'zcode';
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
  | { action: 'import'; manifest: NativeHistoryManifest }
  | { action: 'read'; id: string; offset: number }
  | { action: 'write'; id: string; offset: number; data: string }
  | { action: 'restore'; id: string }
  | { action: 'release'; id: string };

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
  if (v.action === 'import') return { action: 'import', manifest: parseNativeHistoryManifest(v.manifest) };
  const id = text(v.id, 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) invalid();
  if (v.action === 'release' || v.action === 'restore') return { action: v.action, id };
  const offset = count(v.offset);
  if (v.action === 'read') return { action: 'read', id, offset };
  if (v.action === 'write') {
    const data = text(v.data, Math.ceil(NATIVE_HISTORY_CHUNK_BYTES / 3) * 4);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || Buffer.from(data, 'base64').toString('base64') !== data) invalid();
    return { action: 'write', id, offset, data };
  }
  return invalid();
}

export async function nativeHistoryDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export interface NativeHistoryStorage {
  locate(kind: Kind, nativeId: string): Promise<{ file: string; state?: NativeHistoryManifest['state'] }>;
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
  return async (scope: string, raw: unknown, workingDir: string, assertCurrent: () => void): Promise<unknown> => {
    const command = parseNativeHistoryCommand(raw);
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
          const source = await storage.locate(command.kind, command.nativeId);
          const before = await fs.stat(source.file);
          if (!before.isFile()) invalid();
          await fs.copyFile(source.file, file);
          await fs.chmod(file, 0o600);
          const after = await fs.stat(source.file);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('NATIVE_HISTORY_CHANGED');
          manifest = parseNativeHistoryManifest({ kind: command.kind, nativeId: command.nativeId,
            bytes: before.size, sha256: await nativeHistoryDigest(file), ...(source.state ? { state: source.state } : {}) });
        } else {
          manifest = command.manifest;
          await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
        }
        assertCurrent();
        transfers.set(id, { scope, file, manifest, direction: command.action, offset: 0, touched: Date.now(), busy: false, assertOwner: assertCurrent });
        renew(id);
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
          const buffer = Buffer.alloc(Math.min(NATIVE_HISTORY_CHUNK_BYTES, entry.manifest.bytes - command.offset));
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
