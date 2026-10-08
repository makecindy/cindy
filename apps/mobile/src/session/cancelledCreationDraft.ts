import { managedWorktreeBaseRepo } from '@cindy/maker-shared/worktree-paths';
import type { DurableOutboxRecord } from './durableOutbox';

/** Called only after the host has fenced this session ID and acknowledged cleanup. */
export function cancelledCreationDraft(record: DurableOutboxRecord): DurableOutboxRecord {
  if (!record.creation || record.prepared || record.enqueueStarted || record.sendAtMs !== undefined) {
    throw new Error('OUTBOX_CREATION_OWNERSHIP_UNRESOLVED');
  }
  const creation = record.creation;
  // Pre-field records used Cindy's managed worktree layout. Never restore its deleted directory.
  const originalWorkingDir = creation.originalWorkingDir
    ?? managedWorktreeBaseRepo(creation.draft.workingDir)
    ?? '';
  return {
    ...record, suspended: true, state: 'failed',
    creation: {
      ...creation, cancelled: true, originalWorkingDir,
      draft: { ...creation.draft, workingDir: originalWorkingDir },
    },
  };
}

/** Preserve the one durable key and attachment directory; only the remote identity rotates. */
export function outboxCreationRetryIdentity(record: DurableOutboxRecord, newSessionId: () => string) {
  return {
    sessionId: record.creation?.cancelled ? newSessionId() : record.item.sessionId,
    storageSessionId: record.storageSessionId ?? record.item.sessionId,
  };
}
