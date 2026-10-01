import path from 'node:path';
import { getActiveAppSession } from '../appSessionState.js';
import { codexAccountHome } from './codex-account-auth.js';
import { readCodexThreadStorageForArchive } from './codex-local-sessions.js';
import { CodexThreadLocations } from './codex-thread-locations.js';

/** Thread locations of the active owner. Multi-account history lives outside the desktop Codex home. */
export function ownerCodexThreadLocations(): CodexThreadLocations {
  return new CodexThreadLocations(path.join(codexAccountHome('thread-index'), 'locations'));
}

/**
 * Locate a thread's existing history without adopting, copying or recording it.
 * Indexed (account) storage wins; unindexed threads resolve their original storage.
 */
export async function readCodexThreadStorageReadOnly(threadId: string): Promise<
  { historyHome: string; sqliteHome: string; rolloutPath?: string } | undefined
> {
  if (!getActiveAppSession().dataOwnerId) return readCodexThreadStorageForArchive(threadId);
  return await ownerCodexThreadLocations().readStorage(threadId)
    ?? readCodexThreadStorageForArchive(threadId);
}
