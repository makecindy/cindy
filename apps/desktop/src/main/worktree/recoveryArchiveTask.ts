import * as io from './recoveryArchiveIO';
import type { FileEvidence, WorktreeRecoveryArchive } from './recoveryArchiveIO';

type ArchiveInput = { archive: WorktreeRecoveryArchive; directory: string; key: Uint8Array; maxBytes?: number };
export type RecoveryArchiveTask =
  | { operation: 'inventory'; root: string }
  | { operation: 'create'; root: string; resourceId: string; directory: string; key: Uint8Array; encryptedKey: string; iv: Uint8Array; maxBytes?: number }
  | ({ operation: 'verify' } & ArchiveInput)
  | ({ operation: 'extract'; staging: string; keep: boolean } & ArchiveInput);
export type RecoveryArchiveResult<T extends RecoveryArchiveTask> =
  T extends { operation: 'inventory' } ? Record<string, FileEvidence> :
  T extends { operation: 'create' } ? WorktreeRecoveryArchive : void;

/** Run only with physical filesystem semantics (Node, or the isolated Electron worker). */
export async function executeRecoveryArchiveTask(task: RecoveryArchiveTask) {
  try {
    switch (task.operation) {
      case 'inventory': return await io.inventoryWorktree(task.root);
      case 'create': return await io.createRecoveryArchive(task.root, task.resourceId, task.directory, task.key, task.encryptedKey, task.iv, task.maxBytes);
      case 'verify': return await io.verifyRecoveryArchive(task.archive, task.directory, task.key, task.maxBytes);
      case 'extract': return await io.extractRecoveryArchive(task.archive, task.staging, task.keep, task.directory, task.key, task.maxBytes);
    }
  } finally {
    if ('key' in task) task.key.fill(0);
  }
}
