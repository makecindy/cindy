import { randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';

import { recycleJournalRoot } from './recycleJournal';
import { runRecoveryArchiveTask } from './recoveryArchiveWorkerClient';
import type { FileEvidence, WorktreeRecoveryArchive } from './recoveryArchiveIO';

export type { WorktreeRecoveryArchive } from './recoveryArchiveIO';
export { sameWorktreeFiles } from './recoveryArchiveIO';

export function inventoryWorktree(root: string): Promise<Record<string, FileEvidence>> {
  return runRecoveryArchiveTask({ operation: 'inventory', root });
}

export async function createRecoveryArchive(root: string, resourceId: string): Promise<WorktreeRecoveryArchive> {
  const key = randomBytes(32);
  try {
    const encryptedKey = safeStorage.encryptString(key.toString('base64')).toString('base64');
    return await runRecoveryArchiveTask({
      operation: 'create', root, resourceId, directory: recycleJournalRoot(),
      key, encryptedKey, iv: randomBytes(12),
    });
  } finally { key.fill(0); }
}

async function withArchiveKey<T>(archive: WorktreeRecoveryArchive, run: (key: Buffer) => Promise<T>): Promise<T> {
  const key = Buffer.from(safeStorage.decryptString(Buffer.from(archive.encryptedKey, 'base64')), 'base64');
  try { return await run(key); } finally { key.fill(0); }
}

export function verifyRecoveryArchive(archive: WorktreeRecoveryArchive): Promise<void> {
  return withArchiveKey(archive, (key) => runRecoveryArchiveTask({
    operation: 'verify', archive, directory: recycleJournalRoot(), key,
  }));
}

export function extractRecoveryArchive(archive: WorktreeRecoveryArchive, staging: string, keep = false): Promise<void> {
  return withArchiveKey(archive, (key) => runRecoveryArchiveTask({
    operation: 'extract', archive, staging, keep, directory: recycleJournalRoot(), key,
  }));
}
