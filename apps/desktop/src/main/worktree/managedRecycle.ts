import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { captureWorktreeContent, worktreeContentBaselineMatches } from './contentSnapshot';
import { gitExec } from './gitExec';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import {
  newRecycleRecord, readRecycleRecord, writeRecycleRecord, worktreeGeneration,
  type WorktreeRecycleRecord,
} from './recycleJournal';
import { createRecoveryArchive, inventoryWorktree, sameWorktreeFiles, verifyRecoveryArchive } from './recoveryArchive';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { isManagedWorktreePath } from './safety';
import { assertManagedResourcePath, assertWorktreeGitIdentity } from './resourceSafety';
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
  if (!current || worktreeGeneration(current) !== worktreeGeneration(meta) || await hasOtherGeneration(meta)) throw new Error('pooled generation changed');
  await assertManagedResourcePath(meta, store.getAllPaths());
  await assertWorktreeGitIdentity(meta);
  if (hasLiveSessionReference(meta, await loadLiveSessionPathKeys({ contextPath: meta.path }))) {
    throw new Error('pooled worktree is referenced');
  }
  const record = await newRecycleRecord(meta);
  record.directoryIdentity = (await directoryIdentity(meta.path)) ?? undefined;
  if (!record.directoryIdentity || !isManagedWorktreePath(meta.path, meta.baseRepo, store.getAllPaths())) {
    throw new Error('pooled worktree path is unsafe');
  }
  const gitLink = await fs.lstat(path.join(meta.path, '.git'));
  if (!gitLink.isFile() || gitLink.isSymbolicLink()) throw new Error('pooled worktree Git link is missing');
  record.archive = await createRecoveryArchive(meta.path, record.id);
  record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`);
  if (hasLiveSessionReference(meta, await loadLiveSessionPathKeys({ contextPath: meta.path }))
    || !(await worktreeContentBaselineMatches(meta.path, record.snapshot))
    || !sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files)) {
    throw new Error('pooled worktree changed before reuse');
  }
  await assertManagedResourcePath(meta, store.getAllPaths());
  await assertWorktreeGitIdentity(meta);
  if (await directoryIdentity(meta.path) !== record.directoryIdentity) throw new Error('pooled directory replaced');
  record.phase = 'removed';
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
    if (registered && worktreeGeneration(registered) !== worktreeGeneration(meta)) return false;
    if (await hasOtherGeneration(meta)) return false;
    let record = await readRecycleRecord(meta.path);
    if (!record || record.generation !== worktreeGeneration(meta)) {
      record = await newRecycleRecord(meta);
      record.directoryIdentity = (await directoryIdentity(meta.path)) ?? undefined;
      await writeRecycleRecord(record);
    }
    const defer = async (reason: string): Promise<false> => {
      record.reason = reason;
      record.attempts += 1;
      record.nextAttemptAt = Date.now() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(record.attempts, 9));
      await writeRecycleRecord(record);
      return false;
    };
    const canRemove = async (): Promise<boolean> => {
      if (!legacyGuardHeld()) return false;
      if (!options.canRemove || !(await options.canRemove())) return false;
      const current = store.get(meta.sessionId);
      if (current && worktreeGeneration(current) !== record.generation) return false;
      const refs = await loadLiveSessionPathKeys({
        contextPath: meta.path, excludeSessionId: meta.sessionId,
        isSessionRuntimeAlive: options.isSessionRuntimeAlive,
      });
      return !hasLiveSessionReference({ ...meta, path: await physicalWorktreeKey(meta.path) }, refs);
    };
    try {
      if (meta.quarantinePath) return defer('legacy-quarantine-needs-review');
      if (!(await canRemove())) return defer('referenced-or-runtime-unavailable');
      const identity = await directoryIdentity(meta.path);
      if (identity === null) {
        record.phase = 'removed';
        await writeRecycleRecord(record);
        await options.onRemoved?.();
        await unregisterResource(meta);
        return true;
      }
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
      const partialRemoval = record.phase === 'removing' && record.snapshot && record.archive;
      if (!partialRemoval) {
        // A missing .git must never fall through to the parent repository.
        await assertWorktreeGitIdentity(meta);
        // Save all bytes, including ignored files, before touching the live directory.
        if (!record.archive || !sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files)) {
          record.archive = await createRecoveryArchive(meta.path, record.id);
          record.snapshot = undefined;
          await writeRecycleRecord(record);
        }
        if (!record.snapshot || !(await worktreeContentBaselineMatches(meta.path, record.snapshot))) {
          record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`);
        }
        record.phase = 'snapshotted';
        await writeRecycleRecord(record);
      }
      if (!record.archive || !record.snapshot) return defer('recovery-evidence-missing');
      await verifyRecoveryArchive(record.archive);
      if (!sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files, Boolean(partialRemoval))) {
        return defer('files-changed');
      }
      if (!(await canRemove())) return defer('referenced-before-removal');
      if (await directoryIdentity(meta.path) !== identity) return defer('directory-replaced');
      await assertManagedResourcePath(meta, store.getAllPaths());
      let gitLinkPresent = true;
      try { await fs.lstat(path.join(meta.path, '.git')); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        gitLinkPresent = false;
      }
      if (!partialRemoval || gitLinkPresent) {
        await assertWorktreeGitIdentity(meta);
        if (!(await worktreeContentBaselineMatches(meta.path, record.snapshot))) return defer('git-baseline-changed');
      }
      record.phase = 'removing';
      await writeRecycleRecord(record);
      // Revalidate immediately before the destructive Git operation. The
      // earlier inventory is only a snapshot; a late editor/IDE write or a
      // newly live reference must keep this generation protected.
      if (!record.archive || !record.snapshot) return defer('recovery-evidence-missing');
      await verifyRecoveryArchive(record.archive);
      if (!sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files, Boolean(partialRemoval))) {
        return defer('files-changed-before-removal');
      }
      if (!(await canRemove())) return defer('referenced-before-removal');
      if (await directoryIdentity(meta.path) !== identity) return defer('directory-replaced');
      await assertManagedResourcePath(meta, store.getAllPaths());
      let finalGitLinkPresent = true;
      try { await fs.lstat(path.join(meta.path, '.git')); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        finalGitLinkPresent = false;
      }
      if (!partialRemoval || finalGitLinkPresent) {
        await assertWorktreeGitIdentity(meta);
        if (!(await worktreeContentBaselineMatches(meta.path, record.snapshot))) return defer('git-baseline-changed-before-removal');
      }
      try {
        await gitExec(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', meta.path], meta.baseRepo);
      } catch {
        // Git may remove .git before Windows reports EBUSY. Only delete surviving
        // bytes still covered by this generation's authenticated recovery archive.
        if (await directoryIdentity(meta.path) !== identity) return defer('remove-unconfirmed');
        if (!(await canRemove())) return defer('referenced-before-fallback');
        if (!sameWorktreeFiles(await inventoryWorktree(meta.path), record.archive.files, true)) return defer('residual-files-changed');
        await assertManagedResourcePath(meta, store.getAllPaths());
        let hasGit = true;
        try { await fs.lstat(path.join(meta.path, '.git')); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          hasGit = false;
        }
        if (hasGit) {
          await assertWorktreeGitIdentity(meta);
          if (!(await worktreeContentBaselineMatches(meta.path, record.snapshot))) return defer('git-baseline-changed');
        }
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
      return defer((error as NodeJS.ErrnoException).code ?? 'recycle-failed');
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
