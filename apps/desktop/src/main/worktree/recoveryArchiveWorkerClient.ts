import path from 'node:path';
import { createRecoveryArchiveWorkerClient } from '@cindy/worktree-core/recoveryArchiveWorkerClient';
export { RECOVERY_ARCHIVE_TIMEOUT_MS } from '@cindy/worktree-core/recoveryArchiveWorkerClient';
export const { runRecoveryArchiveTask } = createRecoveryArchiveWorkerClient(() =>
  path.join(__dirname, 'recoveryArchiveWorker.js'),
);
