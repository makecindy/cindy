import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isProviderSharePeer } from '@cindy/device-link';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../../appSessionState';
import { ownerScopedPath } from '../../dataOwnerPath';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { createLogger } from '../../logger';
import { getUserDataDir } from '../../userDataPath';
import {
  NATIVE_HISTORY_BACKUP_BYTES, NATIVE_HISTORY_BACKUP_CHUNK_BYTES, NATIVE_HISTORY_CHECKPOINT,
  nativeHistoryDigest, parseNativeHistoryManifest, type NativeHistoryEndpoint, type NativeHistoryManifest,
} from '../nativeHistoryTransfer';

const log = createLogger('native-history-backup');
const MAX_SNAPSHOTS = 8;
const MAX_PENDING = 16;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const HEADER_BYTES = 16 * 1024;
const CHUNK_INTERVAL_MS = 250;

interface HistoryRevision {
  nativeId: string;
  fromDevice: string;
  clearAt: number | null;
  removed: number;
  removedAt: number | null;
  lastMessage: string | null;
  lastSwitch: string | null;
  turnStarted: number | null;
}

interface SavedBackup {
  version: 1;
  revision: HistoryRevision;
  manifest: NativeHistoryManifest;
  sessionId: string;
  anchor: string;
  savedAt: number;
}

function eligibleDevice(device: string | null): device is string {
  return !!device && !isProviderShareAgentDeviceId(device) && !isProviderSharePeer(device);
}

function readOwner() {
  const owner = getActiveAppSession();
  if (owner.mode !== 'cloud' || !owner.dataOwnerId || isAppSessionBoundaryPending()) return null;
  const db = getCurrentDbClientSnapshot();
  if (!db || db.userId !== owner.dataOwnerId) return null;
  const root = ownerScopedPath(getUserDataDir(), owner.dataOwnerId, 'native-history-backups');
  return {
    root, db: db.client, generation: owner.generation,
    assertCurrent() {
      if (getActiveAppSession().generation !== owner.generation || getCurrentDbClientSnapshot() !== db || isAppSessionBoundaryPending()) {
        throw new Error('REMOTE_AGENT_ACCOUNT_CHANGED');
      }
    },
  };
}
type Owner = NonNullable<ReturnType<typeof readOwner>>;

function captureOwner(): Owner | null {
  try { return readOwner(); }
  catch {
    // Backup initialization must never turn a committed task mutation into an error.
    log.debug('remote native history owner storage is unavailable');
    return null;
  }
}

function backupPath(owner: Owner, sessionId: string): string {
  return path.join(owner.root, createHash('sha256').update(sessionId).digest('hex') + '.backup');
}

async function readRevision(owner: Owner, sessionId: string, anchor?: string): Promise<HistoryRevision | null> {
  owner.assertCurrent();
  const row = await owner.db.queryOne<HistoryRevision & { anchorValid: number }>(`
    SELECT s.sdk_session_id AS nativeId, s.agent_device_id AS fromDevice, s.cleared_at AS clearAt,
      s.active_turn_started_at AS turnStarted,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id AND rewind_at IS NOT NULL
        AND (role != 'error')) AS removed,
      (SELECT MAX(rewind_at) FROM messages WHERE session_id = s.id AND rewind_at IS NOT NULL
        AND (role != 'error')) AS removedAt,
      (SELECT id FROM messages WHERE session_id = s.id AND rewind_at IS NULL
        AND created_at > COALESCE(s.cleared_at, 0)
        AND role IN ('user', 'assistant', 'tool_use', 'tool_result', 'thinking')
        ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastMessage,
      (SELECT id FROM messages WHERE session_id = s.id AND rewind_at IS NULL AND role = 'agent_switch'
        ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastSwitch,
      EXISTS (SELECT 1 FROM messages a WHERE a.client_id = ? AND a.session_id = s.id
        AND a.role = 'assistant' AND a.rewind_at IS NULL AND a.created_at > COALESCE(s.cleared_at, 0)
        AND json_valid(a.agent_meta) AND json_extract(a.agent_meta, '$.turnCompleted') = 1
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.rewind_at IS NULL
          AND m.role IN ('assistant', 'user')
          AND (m.created_at > a.created_at OR (m.created_at = a.created_at AND m.rowid > a.rowid))))
        AS anchorValid
    FROM sessions s WHERE s.id = ? AND s.status != 'deleted' AND s.agent_kind = 'pi' AND s.remote_host_id IS NULL
  `, [anchor ?? null, sessionId]);
  owner.assertCurrent();
  if (!row?.nativeId || !eligibleDevice(row.fromDevice) || (anchor !== undefined && !row.anchorValid)) return null;
  const { anchorValid: _, ...revision } = row;
  return revision;
}

function sameHistory(a: HistoryRevision, b: HistoryRevision | null): boolean {
  return !!b && a.nativeId === b.nativeId && a.fromDevice === b.fromDevice && a.clearAt === b.clearAt
    && a.removed === b.removed && a.removedAt === b.removedAt && a.lastSwitch === b.lastSwitch;
}

function sameRevision(a: HistoryRevision, b: HistoryRevision | null): boolean {
  return sameHistory(a, b) && a.lastMessage === b?.lastMessage && a.turnStarted === b?.turnStarted;
}

async function readBackup(file: string): Promise<{ backup: SavedBackup; offset: number } | null> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      if (newline < 0) return null;
      const backup = JSON.parse(buffer.toString('utf8', 0, newline)) as SavedBackup | null;
      if (!backup || backup.version !== 1) return null;
      const manifest = parseNativeHistoryManifest(backup.manifest);
      if (manifest.kind !== 'pi' || manifest.bytes > NATIVE_HISTORY_BACKUP_BYTES || !backup.revision
        || typeof backup.sessionId !== 'string' || typeof backup.anchor !== 'string' || !Number.isFinite(backup.savedAt)
        || backup.savedAt < Date.now() - MAX_AGE_MS || manifest.nativeId !== backup.revision.nativeId
        || (await handle.stat()).size !== newline + 1 + manifest.bytes) return null;
      return { backup: { ...backup, manifest }, offset: newline + 1 };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof Error && error.message === 'REMOTE_AGENT_INVALID')) return null;
    throw error;
  }
}

async function prune(owner: Owner, reservation?: { file: string; revision: HistoryRevision }) {
  const names = await fs.readdir(owner.root).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const retained: { file: string; savedAt: number }[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.backup$/.test(name) && !/^staging-[a-f0-9-]{36}$/.test(name)) continue;
    const file = path.join(owner.root, name);
    const saved = name.endsWith('.backup') ? await readBackup(file) : null;
    // Routine writes only need the current task's DB revision. Startup and
    // destructive edits sweep other tasks using the same durable fence.
    const current = reservation ? (file === reservation.file ? reservation.revision : saved?.backup.revision)
      : saved ? await readRevision(owner, saved.backup.sessionId) : null;
    if (saved && backupPath(owner, saved.backup.sessionId) === file && sameHistory(saved.backup.revision, current ?? null)) {
      if (file !== reservation?.file) retained.push({ file, savedAt: saved.backup.savedAt });
    } else {
      owner.assertCurrent();
      await fs.rm(file, { force: true });
    }
  }
  retained.sort((a, b) => b.savedAt - a.savedAt);
  for (const { file } of retained.slice(MAX_SNAPSHOTS - (reservation ? 1 : 0))) {
    owner.assertCurrent();
    await fs.rm(file, { force: true });
  }
}

interface Checkpoint {
  runId: string;
  token: string;
}

function checkpointOf(data: unknown): Checkpoint | null {
  const value = (data as Record<string, unknown> | null)?.[NATIVE_HISTORY_CHECKPOINT] as Partial<Checkpoint> | null;
  return value && typeof value.runId === 'string'
    && /^[a-f0-9-]{36}$/.test(value.token ?? '') ? value as Checkpoint : null;
}

type Invoke = (device: string, sessionId: string, assertCurrent: () => void) => NativeHistoryEndpoint;
const pending = new Map<string, () => Promise<void>>();
const claims = new Map<string, object>();
const removals = new Map<number, Set<string>>();
let draining = false;

function taskKey(owner: Owner, sessionId: string): string {
  return `backup:${owner.generation}:${sessionId}`;
}

function schedule(key: string, operation: () => Promise<void>): boolean {
  if (!key.startsWith('cleanup:') && !pending.has(key) && pending.size >= MAX_PENDING) return false;
  pending.set(key, operation);
  if (draining) return true;
  draining = true;
  setImmediate(async () => {
    try {
      while (pending.size) {
        const next = [...pending.keys()].find(key => key.startsWith('cleanup:')) ?? pending.keys().next().value!;
        const run = pending.get(next)!;
        pending.delete(next);
        try { await run(); }
        catch { log.debug('remote native history background work did not complete'); }
      }
    } finally { draining = false; }
  });
  return true;
}

/** Run after the existing persistence barrier, without holding the turn or send queue. */
export function scheduleNativeHistoryBackup(sessionId: string, data: unknown, anchor: string,
  persisted: Promise<unknown>, invoke: Invoke): void {
  const ticket = checkpointOf(data);
  if (!ticket) return;
  const checkpoint = ticket;
  const captured = captureOwner();
  if (!captured) return;
  const owner = captured;
  const persistenceComplete = persisted.then(() => true, () => false);
  const key = taskKey(owner, sessionId);
  const claim = {};
  const assertClaim = () => {
    if (claims.get(key) !== claim) throw new Error('NATIVE_HISTORY_CHANGED');
    owner.assertCurrent();
  };
  const accepted = schedule(key, async () => {
    try {
      await save();
    } finally {
      if (claims.get(key) === claim) claims.delete(key);
    }
  });
  if (accepted) claims.set(key, claim);

  async function save() {
    if (!await persistenceComplete) return;
    assertClaim();
    const revision = await readRevision(owner, sessionId, anchor);
    if (!revision) return;
    const final = backupPath(owner, sessionId);
    await prune(owner, { file: final, revision });
    const previous = await readBackup(final);
    const prefix = previous && sameHistory(revision, previous.backup.revision)
      && await nativeHistoryDigest(final, { start: previous.offset }) === previous.backup.manifest.sha256
      ? { bytes: previous.backup.manifest.bytes, sha256: previous.backup.manifest.sha256 } : undefined;
    const staging = path.join(owner.root, 'staging-' + randomUUID());
    const source = invoke(revision.fromDevice, sessionId, assertClaim);
    let id: string | undefined;
    try {
      assertClaim();
      const result = await source({ action: 'checkpoint-export', runId: checkpoint.runId,
        checkpoint: checkpoint.token, ...(prefix ? { prefix } : {}) }) as { id?: unknown; manifest?: unknown; offset?: unknown };
      if (typeof result?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id)) throw new Error('NATIVE_HISTORY_INCOMPLETE');
      id = result.id;
      const manifest = parseNativeHistoryManifest(result.manifest);
      if (manifest.kind !== 'pi' || manifest.nativeId !== revision.nativeId || manifest.bytes > NATIVE_HISTORY_BACKUP_BYTES
        || (result.offset !== 0 && (!prefix || result.offset !== prefix.bytes || prefix.bytes > manifest.bytes))) {
        throw new Error('NATIVE_HISTORY_INCOMPLETE');
      }
      const offset = result.offset as number;
      const header = Buffer.from(JSON.stringify({ version: 1, revision, manifest, sessionId, anchor,
        savedAt: Date.now() } satisfies SavedBackup) + '\n');
      if (header.length > HEADER_BYTES) throw new Error('NATIVE_HISTORY_INCOMPLETE');
      assertClaim();
      await fs.mkdir(owner.root, { recursive: true, mode: 0o700 });
      const output = await fs.open(staging, 'wx', 0o600);
      try {
        await output.writeFile(header);
        if (offset && previous) {
          for await (const bytes of createReadStream(final, { start: previous.offset })) {
            assertClaim();
            await output.writeFile(bytes);
          }
        }
        for (let cursor = offset; cursor < manifest.bytes;) {
          await delay(CHUNK_INTERVAL_MS, undefined, { ref: false });
          assertClaim();
          const limit = Math.min(NATIVE_HISTORY_BACKUP_CHUNK_BYTES, manifest.bytes - cursor);
          const result = await source({ action: 'read', id, offset: cursor, limit, backup: true }) as { data?: string };
          const bytes = Buffer.from(result?.data ?? '', 'base64');
          if (bytes.length !== limit || bytes.toString('base64') !== result.data) throw new Error('NATIVE_HISTORY_INCOMPLETE');
          await output.writeFile(bytes);
          cursor += bytes.length;
        }
        await output.sync();
      } finally { await output.close(); }
      if (await nativeHistoryDigest(staging, { start: header.length }) !== manifest.sha256
        || !sameRevision(revision, await readRevision(owner, sessionId, anchor))) return;
      assertClaim();
      await fs.rename(staging, final);
      let published = false;
      try {
        published = sameHistory(revision, await readRevision(owner, sessionId));
        assertClaim();
      } finally {
        if (!published || claims.get(key) !== claim) await fs.rm(final, { force: true });
      }
    } finally {
      await fs.rm(staging, { force: true }).catch(() => undefined);
      if (id) {
        owner.assertCurrent();
        const release = invoke(revision.fromDevice, sessionId, owner.assertCurrent);
        await release({ action: 'release', id, backup: true }).catch(() => undefined);
      }
    }
  }
}

export function scheduleNativeHistoryBackupCleanup(sessionId?: string, deleted = false): void {
  const owner = captureOwner();
  if (owner) scheduleCleanup(owner, sessionId, deleted);
}

export function captureNativeHistoryBackupCleanup(sessionId: string, deleted = false): () => void {
  const owner = captureOwner();
  return () => {
    if (!owner) return;
    try { owner.assertCurrent(); }
    catch { return; }
    scheduleCleanup(owner, sessionId, deleted);
  };
}

function scheduleCleanup(owner: Owner, sessionId: string | undefined, deleted: boolean): void {
  if (sessionId) {
    const key = taskKey(owner, sessionId);
    claims.delete(key);
    pending.delete(key);
    if (deleted) {
      const files = removals.get(owner.generation) ?? new Set();
      files.add(backupPath(owner, sessionId));
      removals.set(owner.generation, files);
    }
  }
  schedule(`cleanup:${owner.generation}`, async () => {
    const files = removals.get(owner.generation);
    for (const file of files ?? []) {
      owner.assertCurrent();
      await fs.rm(file, { force: true });
      files?.delete(file);
    }
    if (!files?.size) removals.delete(owner.generation);
    await prune(owner);
  });
}

export async function readNativeHistoryBackupEndpoint(input: { sessionId: string; nativeId: string; fromDevice: string },
  assertCurrent: () => void): Promise<{ endpoint: NativeHistoryEndpoint; validate(): Promise<void> } | null> {
  const owner = captureOwner();
  if (!owner || !eligibleDevice(input.fromDevice)) return null;
  const file = backupPath(owner, input.sessionId);
  const wasDeleted = () => removals.get(owner.generation)?.has(file) === true;
  if (wasDeleted()) return null;
  const saved = await readBackup(file);
  if (!saved || saved.backup.sessionId !== input.sessionId || saved.backup.revision.fromDevice !== input.fromDevice
    || saved.backup.manifest.nativeId !== input.nativeId) return null;
  const { backup, offset } = saved;
  const validate = async () => {
    if (!sameRevision(backup.revision, await readRevision(owner, input.sessionId, backup.anchor)) || wasDeleted()) {
      throw new Error('NATIVE_HISTORY_CHANGED');
    }
    assertCurrent();
    owner.assertCurrent();
  };
  if (!sameRevision(backup.revision, await readRevision(owner, input.sessionId, backup.anchor))) return null;
  const id = randomUUID();
  const endpoint: NativeHistoryEndpoint = async command => {
    if (command.action === 'release') return {};
    assertCurrent();
    owner.assertCurrent();
    if (command.action === 'export') {
      if (command.kind !== 'pi' || command.nativeId !== input.nativeId
        || await nativeHistoryDigest(file, { start: offset }) !== backup.manifest.sha256) throw new Error('NATIVE_HISTORY_INCOMPLETE');
      await validate();
      return { id, manifest: backup.manifest };
    }
    if (command.action !== 'read' || command.id !== id || command.offset >= backup.manifest.bytes) throw new Error('REMOTE_AGENT_INVALID');
    const handle = await fs.open(file, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(NATIVE_HISTORY_BACKUP_CHUNK_BYTES, backup.manifest.bytes - command.offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset + command.offset);
      return { data: bytes.subarray(0, bytesRead).toString('base64') };
    } finally { await handle.close(); }
  };
  return { endpoint, validate };
}
