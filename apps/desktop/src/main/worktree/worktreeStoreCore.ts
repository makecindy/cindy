/**
 * Shared Worktree registry and DB synchronization. The JSON backends are bound by
 * each launcher; the registry shape, locks and mutation semantics stay identical.
 */

import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from './types';
import { createLogger } from '../logger';
import { withCrossProcessLock } from '../device-link/crossProcessLock';

const log = createLogger('worktreeStore');

interface WorktreesStoreShape {
  worktrees: Record<string, WorktreeMeta>;
}

interface SafeDirectoryCleanupStoreShape {
  /** Paths whose safe.directory cleanup was deferred until the next startup. */
  pending: string[];
}

export interface WorktreesStoreBackend {
  get(key: 'worktrees', defaultValue: WorktreesStoreShape['worktrees']): WorktreesStoreShape['worktrees'];
  set(key: 'worktrees', value: WorktreesStoreShape['worktrees']): void;
}

export interface SafeDirectoryCleanupStoreBackend {
  get(key: 'pending', defaultValue: SafeDirectoryCleanupStoreShape['pending']): SafeDirectoryCleanupStoreShape['pending'];
  set(key: 'pending', value: SafeDirectoryCleanupStoreShape['pending']): void;
}

export interface WorktreeStorePorts {
  getStore(): WorktreesStoreBackend;
  getCleanupStore(): SafeDirectoryCleanupStoreBackend;
}

let ports: WorktreeStorePorts | null = null;
let setWorktreePathInDb: (sessionId: string, worktreePath: string | null) => Promise<void> = async () => {
  throw new Error('Worktree DB synchronization is not configured');
};

/** Bound by each launcher; the DB field is only a denormalized sidebar snapshot. */
export function configureWorktreeStoreDbSync(
  next: (sessionId: string, worktreePath: string | null) => Promise<void>,
): void {
  setWorktreePathInDb = next;
}

/** Bind the launcher's profile-root JSON backends. */
export function configureWorktreeStorePorts(next: WorktreeStorePorts): void {
  ports = next;
}

function storePorts(): WorktreeStorePorts {
  if (!ports) throw new Error('Worktree store ports are not configured');
  return ports;
}

function readMap(): Record<string, WorktreeMeta> {
  const raw = storePorts().getStore().get('worktrees', {});
  // Historical or damaged data must fail closed rather than making a resource look unreferenced.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid worktree registry');
  return raw as Record<string, WorktreeMeta>;
}

function writeMap(map: Record<string, WorktreeMeta>): void {
  storePorts().getStore().set('worktrees', map);
}

export function getAll(): WorktreeMeta[] {
  return Object.values(readMap());
}

export function get(sessionId: string): WorktreeMeta | null {
  if (!sessionId) return null;
  return readMap()[sessionId] ?? null;
}

/** All recorded paths, including a quarantined location. */
export function getAllPaths(): string[] {
  return getAll().flatMap((m) => (
    m.quarantinePath ? [m.path, m.quarantinePath] : [m.path]
  ));
}

function readPendingSafeDirectoryCleanups(): string[] {
  const raw = storePorts().getCleanupStore().get('pending', []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function pendingSafeDirectoryCleanupLockPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cindy-git-safe-directory-cleanup-${uid}.lock`);
}

export function getPendingSafeDirectoryCleanups(): string[] {
  return readPendingSafeDirectoryCleanups();
}

/** Append deferred cleanup paths without losing another process's update. */
export async function addPendingSafeDirectoryCleanups(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].filter((p) => p && p.length > 0);
  if (unique.length === 0) return;
  await withCrossProcessLock(
    pendingSafeDirectoryCleanupLockPath(),
    { label: 'git-safe-directory-cleanup', waitMs: 1_000 },
    async (status) => {
      if (!status.held) {
        throw new Error('could not acquire the safe.directory cleanup queue lock');
      }
      const existing = new Set(readPendingSafeDirectoryCleanups());
      let changed = false;
      for (const p of unique) {
        if (!existing.has(p)) {
          existing.add(p);
          changed = true;
        }
      }
      if (changed) storePorts().getCleanupStore().set('pending', [...existing]);
    },
  );
}

/** Remove successfully cleaned paths under the same queue lock. */
export async function removePendingSafeDirectoryCleanups(paths: readonly string[]): Promise<void> {
  const toRemove = new Set(paths);
  if (toRemove.size === 0) return;
  await withCrossProcessLock(
    pendingSafeDirectoryCleanupLockPath(),
    { label: 'git-safe-directory-cleanup', waitMs: 1_000 },
    async (status) => {
      if (!status.held) {
        throw new Error('could not acquire the safe.directory cleanup queue lock');
      }
      const current = readPendingSafeDirectoryCleanups();
      const next = current.filter((p) => !toRemove.has(p));
      if (next.length !== current.length) storePorts().getCleanupStore().set('pending', next);
    },
  );
}

/** Write metadata, then best-effort synchronize sessions.worktree_path. */
export async function set(
  sessionId: string,
  meta: WorktreeMeta,
  beforeMutation?: () => Promise<void>,
): Promise<void> {
  if (!sessionId) throw new Error('worktreeStore.set: sessionId is required');
  await mutateRegistry((map) => { map[sessionId] = meta; }, beforeMutation);
  try {
    await setWorktreePathInDb(sessionId, meta.path);
  } catch (err) {
    log.warn(
      `[worktreeStore] DB sync failed for session ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Delete metadata while preserving the historical DB path. */
export async function del(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await mutateRegistry((map) => { delete map[sessionId]; });
}

/** Atomically replace a pooled registration under the registry lock. */
export async function replace(
  previousSessionId: string,
  sessionId: string,
  meta: WorktreeMeta,
  expected?: WorktreeMeta,
  beforeMutation?: () => Promise<void>,
): Promise<void> {
  if (!sessionId) throw new Error('worktreeStore.replace: sessionId is required');
  await mutateRegistry((map) => {
    if (expected && (JSON.stringify(map[previousSessionId]) !== JSON.stringify(expected)
      || (previousSessionId !== sessionId && map[sessionId]))) {
      throw new Error('Worktree ownership changed during transfer');
    }
    if (previousSessionId && previousSessionId !== sessionId) delete map[previousSessionId];
    map[sessionId] = meta;
  }, beforeMutation);
  try {
    await setWorktreePathInDb(sessionId, meta.path);
  } catch (err) {
    log.warn(
      `[worktreeStore] DB sync failed for session ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function mutateRegistry(
  mutate: (map: Record<string, WorktreeMeta>) => void,
  beforeMutation?: () => Promise<void>,
): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  await withCrossProcessLock(path.join(os.tmpdir(), `cindy-worktree-registry-${uid}.lock`),
    { label: 'worktree-registry' }, async (status) => {
      if (!status.held) throw new Error('worktree registry is busy');
      if (beforeMutation) await beforeMutation();
      const map = readMap();
      mutate(map);
      writeMap(map);
    });
}
