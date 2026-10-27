import { deferRecycle, recycleFailureReason, recyclePolicy } from './recyclePolicy';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  captureWorktreeContent, discardableWorktreePaths, releaseSnapshotRef, snapshotTreePaths,
  worktreeContentMatches, worktreeStagedContentMatches,
} from './contentSnapshot';
import { gitExec } from './gitExec';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import { inventoryWorktree, sameWorktreeFiles, verifyRecoveryArchive } from './recoveryArchive';
import {
  newRecycleRecord, readRecycleRecord, writeRecycleRecord, worktreeGeneration, type WorktreeRecycleRecord,
} from './recycleJournal';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { isManagedWorktreePath } from './safety';
import { assertManagedResourcePath, assertWorktreeGitIdentity, gitMetadataUsable } from './resourceSafety';
import * as store from './worktreeStore';
import type { WorktreeMeta } from './types';
import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';
import { withWorktreeRecycleSlot } from './recycleQueue';

export interface ManagedRecycleOptions {
  canRemove?: () => Promise<boolean>;
  isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
  onRemoved?: () => Promise<void>;
}

/** Pool reset is destructive too: preserve the old generation before clean/reset. */
export async function checkpointWorktreeForReuse(meta: WorktreeMeta): Promise<void> {
  const current = store.get(meta.sessionId);
  if (!current || current.pendingSessionTransfer || worktreeGeneration(current) !== worktreeGeneration(meta) || await hasOtherGeneration(meta)) throw new Error('pooled generation changed');
  await assertManagedResourcePath(meta, store.getAllPaths());
  await assertWorktreeGitIdentity(meta);
  if (hasLiveSessionReference(meta, await loadLiveSessionPathKeys({ contextPath: meta.path }))) {
    throw new Error('pooled worktree is referenced');
  }
  const previous = await readRecycleRecord(meta.path);
  if (previous?.generation === worktreeGeneration(meta)
    && ['paused', 'kept'].includes(recyclePolicy(previous).state)) {
    throw new Error('pooled worktree recycling is paused');
  }
  const record = await newRecycleRecord(meta);
  record.directoryIdentity = (await directoryIdentity(meta.path)) ?? undefined;
  if (!record.directoryIdentity || !isManagedWorktreePath(meta.path, meta.baseRepo, store.getAllPaths())) {
    throw new Error('pooled worktree path is unsafe');
  }
  const gitLink = await fs.lstat(path.join(meta.path, '.git'));
  if (!gitLink.isFile() || gitLink.isSymbolicLink()) throw new Error('pooled worktree Git link is missing');
  const snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`, { includeUntracked: true });
  record.snapshot = snapshot;
  try {
    if (hasLiveSessionReference(meta, await loadLiveSessionPathKeys({ contextPath: meta.path }))
      || !(await worktreeContentMatches(meta.path, snapshot))) {
      throw new Error('pooled worktree changed before reuse');
    }
    await assertManagedResourcePath(meta, store.getAllPaths());
    await assertWorktreeGitIdentity(meta);
    if (await directoryIdentity(meta.path) !== record.directoryIdentity) throw new Error('pooled directory replaced');
  } catch (error) {
    // Reuse is abandoned with the checkout intact, and no record names this ref yet.
    await releaseSnapshotRef(meta.baseRepo, snapshot);
    throw error;
  }
  record.phase = 'removed';
  // Keep the ref if this throws: history may already be durable before the current record fails.
  await writeRecycleRecord(record);
}

async function directoryIdentity(value: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('worktree directory identity is unsafe');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hasGitLink(worktreePath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(worktreePath, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Surviving files that removal may delete: none written after `sinceMs` and, when the lists are
 * known, each one either saved in the snapshot or under a path the snapshot left out on purpose.
 * The path check catches files moved or copied in with their old timestamps; content swapped
 * into a saved path with a preserved timestamp remains undetectable. Directories are not dated
 * (deleting children updates them), nor is status-change time (Git may clear a read-only flag
 * before failing to delete a file). Discardable directories are not walked.
 */
async function residualFilesAllowed(
  root: string,
  sinceMs: number,
  saved: ReadonlySet<string> | null,
  discardable: readonly string[] | null,
): Promise<boolean> {
  const discarded = (relative: string): boolean => discardable!.some((entry) => (
    entry.endsWith('/') ? `${relative}/` === entry || relative.startsWith(entry) : relative === entry
  ));
  const walk = async (directory: string, prefix: string): Promise<boolean> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const entryPath = path.join(directory, entry.name);
      // The worktree's own Git link predates removal and is never part of a snapshot.
      if (relative === '.git') continue;
      if (entry.isDirectory()) {
        if (saved && discarded(relative)) continue;
        if (!(await walk(entryPath, `${relative}/`))) return false;
        continue;
      }
      let stat;
      try { stat = await fs.lstat(entryPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (Math.max(stat.mtimeMs, stat.birthtimeMs) > sinceMs) return false;
      if (saved && !saved.has(relative) && !discarded(relative)) return false;
    }
    return true;
  };
  return walk(root, '');
}

/**
 * A partially removed directory may only lose bytes that existed when removal began. The full
 * tree was verified against the snapshot after `removingSince` was taken and before it was
 * recorded, so every file written before that moment was saved, ignored or nested. Older
 * clients' records compare their archive inventory instead, and the archive must still be
 * readable: an integrity failure throws and pauses the request with the directory kept.
 */
async function residualFilesCovered(
  meta: WorktreeMeta,
  record: WorktreeRecycleRecord,
  snapshot: NonNullable<WorktreeRecycleRecord['snapshot']>,
): Promise<boolean> {
  if (record.archive) {
    await verifyRecoveryArchive(record.archive);
    if (!sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files, true)) return false;
  } else {
    const since = record.removingSince;
    if (typeof since !== 'number' || !Number.isFinite(since)) return false;
    const discardable = Array.isArray(record.removalDiscardable) ? record.removalDiscardable : null;
    const saved = discardable ? await snapshotTreePaths(meta.baseRepo, snapshot.tree) : null;
    if (!(await residualFilesAllowed(meta.path, since, saved, discardable))) return false;
  }
  // While Git metadata survives, HEAD, the branch and staged content must be unchanged too.
  if (!(await gitMetadataUsable(meta.path))) return true;
  await assertWorktreeGitIdentity(meta);
  return worktreeStagedContentMatches(meta.path, snapshot);
}

/** Written before the terminal status mutation, so a crash cannot lose the cleanup intent. */
export async function requestWorktreeRecycle(sessionId: string, resourcePaths: readonly string[] = []): Promise<void> {
  const own = store.get(sessionId);
  const paths = new Set(await Promise.all(resourcePaths.map(physicalWorktreeKey)));
  const candidates = own ? [own] : store.getAll();
  for (const meta of candidates) {
    if (meta.ephemeral || (!own && !paths.has(await physicalWorktreeKey(meta.path)))) continue;
    await withWorktreeResourceLock(meta.path, async () => {
      if (worktreeGeneration(store.get(meta.sessionId) ?? meta) !== worktreeGeneration(meta) || await hasOtherGeneration(meta)) return;
      const previous = await readRecycleRecord(meta.path);
      if (previous?.generation === worktreeGeneration(meta) && previous.phase !== 'restored') return;
      const record = await newRecycleRecord(meta);
      record.directoryIdentity = (await directoryIdentity(meta.path)) ?? undefined;
      await writeRecycleRecord(record);
    });
  }
}

/** Complete a single durable request. Failure preserves registration and retry evidence. */
export async function recycleManagedWorktree(meta: WorktreeMeta, options: ManagedRecycleOptions): Promise<boolean> {
  return withWorktreeRecycleSlot(() => recycleManagedWorktreeInSlot(meta, options));
}

async function recycleManagedWorktreeInSlot(meta: WorktreeMeta, options: ManagedRecycleOptions): Promise<boolean> {
  return withWorktreeResourceLock(meta.path, () => withLegacyWorktreeRuntimeGuard(async (legacyGuardHeld) => {
    const registered = store.get(meta.sessionId);
    if (registered?.pendingSessionTransfer) return false;
    if (registered && worktreeGeneration(registered) !== worktreeGeneration(meta)) return false;
    if (await hasOtherGeneration(meta)) return false;
    let record = await readRecycleRecord(meta.path);
    // A restored record's snapshot ref is already released; never complete a removal on it.
    if (!record || record.generation !== worktreeGeneration(meta) || record.phase === 'restored') {
      record = await newRecycleRecord(meta);
      record.directoryIdentity = (await directoryIdentity(meta.path)) ?? undefined;
      await writeRecycleRecord(record);
    }
    const policy = recyclePolicy(record);
    if (policy.state === 'paused' || policy.state === 'kept') return false;
    const startedAt = performance.now();
    const defer = async (reason: string): Promise<false> => {
      deferRecycle(record, reason, performance.now() - startedAt);
      await writeRecycleRecord(record);
      return false;
    };
    // The owner still wants this generation gone (task archived/deleted, no newer registration).
    const ownerAllowsRemoval = async (): Promise<boolean> => {
      if (!legacyGuardHeld()) return false;
      if (!options.canRemove || !(await options.canRemove())) return false;
      const current = store.get(meta.sessionId);
      return !current || worktreeGeneration(current) === record.generation;
    };
    const canRemove = async (): Promise<boolean> => {
      if (!(await ownerAllowsRemoval())) return false;
      const refs = await loadLiveSessionPathKeys({
        contextPath: meta.path, excludeSessionId: meta.sessionId,
        isSessionRuntimeAlive: options.isSessionRuntimeAlive,
      });
      return !hasLiveSessionReference({ ...meta, path: await physicalWorktreeKey(meta.path) }, refs);
    };
    try {
      if (meta.quarantinePath) return defer('legacy-quarantine-needs-review');
      if (!(await ownerAllowsRemoval())) return defer('referenced-or-runtime-unavailable');
      const identity = await directoryIdentity(meta.path);
      if (identity === null) {
        // Nothing left to delete, so other references cannot keep this request waiting.
        record.phase = 'removed';
        record.reason = undefined;
        await writeRecycleRecord(record);
        await gitExec(['worktree', 'prune'], meta.baseRepo).catch(() => undefined);
        await options.onRemoved?.();
        if (await canRemove()) await unregisterResource(meta);
        else await store.del(meta.sessionId);
        return true;
      }
      if (!(await canRemove())) return defer('referenced-or-runtime-unavailable');
      if (record.directoryIdentity && identity !== record.directoryIdentity) return defer('directory-replaced');
      if (!isManagedWorktreePath(meta.path, meta.baseRepo, store.getAllPaths())) return defer('unmanaged-path');
      const realParent = await physicalWorktreeKey(path.dirname(meta.path));
      const expectedParent = path.join(await physicalWorktreeKey(meta.baseRepo), path.basename(path.dirname(meta.path)));
      if (realParent !== expectedParent) return defer('redirected-worktree-parent');
      try {
        await fs.lstat(path.join(meta.path, '.worktree-keep'));
        return defer('keep-sentinel');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      record.directoryIdentity = identity;
      await assertManagedResourcePath(meta, store.getAllPaths());
      // Once deletion may have started, the directory can be partial (Windows stops at the first
      // locked file, with or without .git). Never snapshot it again: that would replace the
      // snapshot verified before deletion with a tree missing the files already deleted.
      const resumingRemoval = record.phase === 'removing' && Boolean(record.snapshot);
      if (!resumingRemoval) {
        // A missing .git must never fall through to the parent repository.
        await assertWorktreeGitIdentity(meta);
        // Git keeps tracked and new files; ignored files and nested repositories are not saved.
        let superseded: WorktreeRecycleRecord['snapshot'];
        if (!record.snapshot || !(await worktreeContentMatches(meta.path, record.snapshot))) {
          superseded = record.snapshot;
          record.snapshot = await captureWorktreeContent(
            meta.path, `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`, { includeUntracked: true },
          );
          record.archive = undefined;
        }
        record.phase = 'snapshotted';
        await writeRecycleRecord(record);
        // The new snapshot holds everything still present; the older one can no longer be restored.
        if (superseded && superseded.ref !== record.snapshot.ref) await releaseSnapshotRef(meta.baseRepo, superseded);
      }
      const snapshot = record.snapshot;
      if (!snapshot) return defer('recovery-evidence-missing');
      // Before deletion: the whole tree must still match the snapshot. After it may have started:
      // every surviving file must already have been covered when removal began.
      const contentUnchanged = async (): Promise<boolean> => {
        if (record.phase === 'removing') return residualFilesCovered(meta, record, snapshot);
        if (!(await hasGitLink(meta.path))) return false;
        await assertWorktreeGitIdentity(meta);
        return worktreeContentMatches(meta.path, snapshot);
      };
      if (!(await canRemove())) return defer('referenced-before-removal');
      if (await directoryIdentity(meta.path) !== identity) return defer('directory-replaced');
      await assertManagedResourcePath(meta, store.getAllPaths());
      if (!(await contentUnchanged())) return defer(resumingRemoval ? 'residual-files-changed' : 'git-baseline-changed');
      if (!resumingRemoval) {
        // Revalidate the full tree immediately before the destructive Git operation; a late
        // editor/IDE write or a newly live reference keeps this generation protected. The
        // boundary is taken first and recorded only once the verification has completed, so
        // an interrupted verification leaves the request `snapshotted` and nothing unverified
        // can ever count as covered.
        const since = Date.now();
        if (!(await canRemove())) return defer('referenced-before-removal');
        if (await directoryIdentity(meta.path) !== identity) return defer('directory-replaced');
        await assertManagedResourcePath(meta, store.getAllPaths());
        await assertWorktreeGitIdentity(meta);
        if (!(await worktreeContentMatches(meta.path, snapshot))) return defer('git-baseline-changed-before-removal');
        record.removalDiscardable = (await discardableWorktreePaths(meta.path)) ?? undefined;
        record.removingSince = since;
        record.phase = 'removing';
        await writeRecycleRecord(record);
      }
      try {
        await gitExec(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', meta.path], meta.baseRepo);
      } catch {
        if (await directoryIdentity(meta.path) !== identity) return defer('remove-unconfirmed');
        if (!(await canRemove())) return defer('referenced-before-fallback');
        await assertManagedResourcePath(meta, store.getAllPaths());
        // Only bytes that existed when removal began (saved, ignored or nested) may be deleted.
        if (!(await residualFilesCovered(meta, record, snapshot))) return defer('residual-files-changed');
        if (await directoryIdentity(meta.path) !== identity) return defer('directory-replaced');
        await fs.rm(meta.path, { recursive: true, force: true });
      }
      if (await directoryIdentity(meta.path) !== null) return defer('directory-still-present');
      await gitExec(['worktree', 'prune'], meta.baseRepo);
      record.phase = 'removed';
      record.reason = undefined;
      await writeRecycleRecord(record);
      await options.onRemoved?.();
      await unregisterResource(meta);
      return true;
    } catch (error) {
      return defer(recycleFailureReason(error));
    }
  }));
}

async function unregisterResource(meta: WorktreeMeta): Promise<void> {
  const physicalPath = await physicalWorktreeKey(meta.path);
  for (const entry of store.getAll()) {
    if (await physicalWorktreeKey(entry.path) === physicalPath) await store.del(entry.sessionId);
  }
}

async function hasOtherGeneration(meta: WorktreeMeta): Promise<boolean> {
  const physicalPath = await physicalWorktreeKey(meta.path);
  for (const entry of store.getAll()) {
    if (worktreeGeneration(entry) !== worktreeGeneration(meta)
      && await physicalWorktreeKey(entry.path) === physicalPath) return true;
  }
  return false;
}
