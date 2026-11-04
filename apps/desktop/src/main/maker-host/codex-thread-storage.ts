import path from 'node:path';
import { activeOwnerScopeKey, getActiveAppSession } from '../appSessionState.js';
import { codexAccountHome } from './codex-account-auth.js';
import { readCodexThreadStorageForArchiveAsync, prepareCodexRolloutForResume } from './codex-local-sessions.js';
import { CodexThreadLocations } from './codex-thread-locations.js';

/** Thread locations of the active owner. Multi-account history lives outside the desktop Codex home. */
export function ownerCodexThreadLocations(): CodexThreadLocations {
  return new CodexThreadLocations(path.join(codexAccountHome('thread-index'), 'locations'), prepareCodexRolloutForResume);
}

/**
 * Locate a thread's existing history without adopting, copying or recording it.
 * Indexed (account) storage wins; unindexed threads resolve their original storage.
 */
export async function readCodexThreadStorageReadOnly(threadId: string): Promise<
  { historyHome: string; sqliteHome: string; rolloutPath?: string } | undefined
> {
  const owner = activeOwnerScopeKey();
  const indexed = getActiveAppSession().dataOwnerId
    ? await ownerCodexThreadLocations().readStorage(threadId) : undefined;
  if (owner !== activeOwnerScopeKey()) throw new Error('Codex history owner changed');
  const storage = indexed ?? await readCodexThreadStorageForArchiveAsync(threadId);
  if (owner !== activeOwnerScopeKey()) throw new Error('Codex history owner changed');
  return storage;
}
