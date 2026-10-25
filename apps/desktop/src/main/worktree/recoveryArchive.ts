import { safeStorage } from 'electron';
import { recycleJournalRoot } from './recycleJournal';
import { runRecoveryArchiveTask } from './recoveryArchiveWorkerClient';
import { createWorktreeRecoveryArchives } from '@cindy/worktree-core/recoveryArchive';
export { sameWorktreeFiles } from '@cindy/worktree-core/recoveryArchive';
export type { WorktreeRecoveryArchive } from '@cindy/worktree-core/recoveryArchive';
export const {
  inventoryWorktree,
  createRecoveryArchive,
  verifyRecoveryArchive,
  extractRecoveryArchive,
} = createWorktreeRecoveryArchives({
  recycleJournalRoot,
  runRecoveryArchiveTask,
  wrapArchiveKey: async (key) =>
    safeStorage.encryptString(key.toString('base64')).toString('base64'),
  unwrapArchiveKey: async (encryptedKey) =>
    Buffer.from(safeStorage.decryptString(Buffer.from(encryptedKey, 'base64')), 'base64'),
});
