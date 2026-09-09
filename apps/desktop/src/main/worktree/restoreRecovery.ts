import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { GitExecError, gitExec } from './gitExec';
import { readRecycleRecord, writeRecycleRecord, worktreeGeneration } from './recycleJournal';
import { extractRecoveryArchive, inventoryWorktree, sameWorktreeFiles, verifyRecoveryArchive } from './recoveryArchive';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import { assertManagedResourceLocation, assertManagedResourcePath, assertWorktreeGitIdentity } from './resourceSafety';
import * as store from './worktreeStore';
import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';
import { readWorktreeHeadRef } from './contentSnapshot';

function restoreCheckoutPathIsSafe(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  const root = path.resolve(os.tmpdir());
  const relative = path.relative(root, value);
  const parts = relative.split(path.sep);
  return parts.length === 2
    && parts[0].startsWith('cindy-worktree-restore-')
    && /^[0-9a-f-]{36}$/i.test(parts[0].slice('cindy-worktree-restore-'.length))
    && parts[1] === 'checkout';
}

async function indexIsRestorable(worktreePath: string, indexTree: string): Promise<boolean> {
  const { stdout } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
  try { await fs.lstat(stdout.trim()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    await gitExec(['diff', '--cached', '--quiet', indexTree, '--'], worktreePath, { extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });
    return true;
  } catch { return false; }
}

/** Restore new recovery records; return null to retain compatibility with older stash/branch recovery. */
export async function restoreRecordedWorktree(sessionId: string, worktreePath: string): Promise<boolean | null> {
  // Keep ordinary present/legacy lookups free of Windows helper processes.
  const pending = await readRecycleRecord(worktreePath, sessionId);
  if (!pending?.archive || !pending.snapshot || pending.phase === 'restored' || pending.phase === 'pending') return null;
  return withWorktreeResourceLock(worktreePath, () => withLegacyWorktreeRuntimeGuard(async (legacyGuardHeld) => {
    const record = await readRecycleRecord(worktreePath, sessionId);
    if (!record?.snapshot || !record.archive || record.phase === 'restored' || record.phase === 'pending') return null;
    if ([record.snapshot.head, record.snapshot.tree, record.snapshot.indexTree, record.snapshot.commit]
      .some((value) => typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) return false;
    const headRef = record.snapshot.headRef;
    if (headRef != null && (typeof headRef !== 'string' || !headRef.startsWith('refs/heads/'))) return false;
    if (await physicalWorktreeKey(record.meta.path) !== await physicalWorktreeKey(worktreePath)) return false;
    const registered = store.get(sessionId);
    if (registered && worktreeGeneration(registered) === record.restoredGeneration) {
      // Registration was the final mutation; finish a journal write interrupted by a crash.
      record.phase = 'restored';
      await writeRecycleRecord(record);
      return true;
    }
    if (registered && worktreeGeneration(registered) !== record.generation) return false;
    for (const entry of store.getAll()) {
      if (await physicalWorktreeKey(entry.path) === await physicalWorktreeKey(worktreePath)
        && worktreeGeneration(entry) !== record.generation) return false;
    }
    await assertManagedResourceLocation(record.meta, [worktreePath]);
    let identity: string | null = null;
    try {
      const stat = await fs.lstat(worktreePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const reservedRecoveryDirectory = record.phase === 'restoring' && record.directoryIdentity == null;
    if (identity !== null && !reservedRecoveryDirectory && identity !== record.directoryIdentity) return false;
    if (identity !== null && reservedRecoveryDirectory) {
      // A crash may have happened after mkdir and before its identity was journaled.
      // Only an empty directory can be adopted; user bytes always stop recovery.
      if ((await fs.readdir(worktreePath)).length !== 0) return false;
      record.directoryIdentity = identity;
      await writeRecycleRecord(record);
    }
    if (identity !== null) {
      if (record.phase === 'snapshotted') {
        // Snapshotting never mutates the live checkout. Cancelling recycling needs no apply.
        record.phase = 'restored';
        await writeRecycleRecord(record);
        return true;
      }
      await assertManagedResourcePath(record.meta, [worktreePath]);
      if (!sameWorktreeFiles(await inventoryWorktree(worktreePath), record.archive.files, true)) return false;
    }
    if (hasLiveSessionReference(record.meta, await loadLiveSessionPathKeys({ excludeSessionId: sessionId }))) return false;
    await verifyRecoveryArchive(record.archive);
    if (!legacyGuardHeld()) return false;
    if (headRef) {
      try {
        await gitExec(['show-ref', '--verify', '--quiet', headRef], record.meta.baseRepo);
      } catch (error) {
        if (!(error instanceof GitExecError) || error.exitCode !== 1) throw error;
        // Recreate only a missing ref. A concurrent creator must never be overwritten,
        // nor may a symbolic ref redirect this write to another branch.
        await gitExec(['update-ref', '--no-deref', headRef, record.snapshot.head, '0'.repeat(record.snapshot.head.length)], record.meta.baseRepo);
      }
      // Never reset a branch that advanced or was replaced while this task was archived.
      const { stdout: branchHead } = await gitExec(['rev-parse', '--verify', `${headRef}^{commit}`], record.meta.baseRepo);
      if (branchHead.trim() !== record.snapshot.head) return false;
    }
    if (!legacyGuardHeld()) return false;
    if (identity === null) {
      record.phase = 'restoring';
      record.restoredGeneration ??= randomUUID();
      record.directoryIdentity = null;
      await writeRecycleRecord(record);
      await fs.mkdir(worktreePath, { recursive: false });
      const stat = await fs.lstat(worktreePath);
      record.directoryIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    }
    record.phase = 'restoring';
    record.restoredGeneration ??= randomUUID();
    await writeRecycleRecord(record);
    const gitLink = path.join(worktreePath, '.git');
    let gitLinkExists = true;
    try {
      await fs.lstat(gitLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      gitLinkExists = false;
    }
    if (!gitLinkExists || record.restoreCheckoutPath) {
      // Repair a partially deleted worktree without deleting any remaining user file.
      // Persist the temporary checkout before creating it so a crash after `worktree add`
      // can resume the same checkout instead of leaving its branch permanently occupied.
      const checkout = record.restoreCheckoutPath ?? path.join(
        os.tmpdir(), `cindy-worktree-restore-${randomUUID()}`, 'checkout',
      );
      if (!restoreCheckoutPathIsSafe(checkout)) return false;
      if (record.restoreCheckoutPath !== checkout) {
        record.restoreCheckoutPath = checkout;
        await writeRecycleRecord(record);
      }
      const checkoutRoot = path.dirname(checkout);
      let checkoutEntries: string[] | null = null;
      try {
        const stat = await fs.lstat(checkout);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        checkoutEntries = await fs.readdir(checkout);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await gitExec(['worktree', 'prune'], record.meta.baseRepo);
      // Git checks branch occupancy itself; no --force/-B may bypass another checkout.
      const target = headRef ? headRef.slice('refs/heads/'.length) : record.snapshot.head;
      if (checkoutEntries === null || checkoutEntries.length === 0) {
        await fs.mkdir(checkoutRoot, { recursive: true });
        await gitExec(['worktree', 'add', '--no-checkout', ...(headRef ? [] : ['--detach']), checkout, target], record.meta.baseRepo);
      } else if (!checkoutEntries.includes('.git')) {
        // Never delete or adopt an unexpected non-empty temporary directory.
        return false;
      }
      try {
        await fs.copyFile(path.join(checkout, '.git'), gitLink, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await gitExec(['worktree', 'repair', worktreePath], record.meta.baseRepo);
      await fs.rm(checkoutRoot, { recursive: true, force: true });
      record.restoreCheckoutPath = undefined;
      await writeRecycleRecord(record);
    }
    await assertManagedResourcePath(record.meta, [worktreePath]);
    await assertWorktreeGitIdentity(record.meta);
    if (!legacyGuardHeld()) return false;
    const { stdout: head } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (head.trim() !== record.snapshot.head) return false;
    if (headRef !== undefined && await readWorktreeHeadRef(worktreePath) !== headRef) return false;
    if (!(await indexIsRestorable(worktreePath, record.snapshot.indexTree))) return false;
    await extractRecoveryArchive(record.archive, worktreePath, true);
    if (hasLiveSessionReference(record.meta, await loadLiveSessionPathKeys({ excludeSessionId: sessionId }))) return false;
    await assertManagedResourcePath(record.meta, [worktreePath]);
    await assertWorktreeGitIdentity(record.meta);
    if (!legacyGuardHeld()) return false;
    const { stdout: currentHead } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (currentHead.trim() !== record.snapshot.head) return false;
    if (headRef !== undefined && await readWorktreeHeadRef(worktreePath) !== headRef) return false;
    if (!(await indexIsRestorable(worktreePath, record.snapshot.indexTree))) return false;
    await gitExec(['read-tree', record.snapshot.indexTree], worktreePath);
    await store.set(sessionId, { ...record.meta, sessionId,
      ...(headRef ? { branch: headRef.slice('refs/heads/'.length) } : {}),
      generation: record.restoredGeneration, quarantinePath: undefined });
    record.phase = 'restored';
    await writeRecycleRecord(record);
    return true;
  }));
}
