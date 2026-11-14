import { activeOwnerScopeKey, getActiveAppSession } from '../appSessionState.js';
import { codexAccountHome } from './codex-account-auth.desktop.js';
import { getCodexHome } from './codex-home-path.js';
import { readCodexThreadStorageForArchiveAsync, prepareCodexRolloutForResume, prepareExternalCodexSessionForResume } from './codex-local-sessions.js';
import { CodexThreadLocations } from './codex-thread-locations.js';
import { createCodexThreadStorage } from './codexThreadStorageCore.js';

// Keep imported functions live across module cycles and late export replacements.
const storage = createCodexThreadStorage({
  activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args),
  getActiveAppSession: (...args) => getActiveAppSession(...args),
  codexAccountHome: (...args) => codexAccountHome(...args),
  getCodexHome: (...args) => getCodexHome(...args),
  CodexThreadLocations,
  readCodexThreadStorageForArchiveAsync: (...args) => readCodexThreadStorageForArchiveAsync(...args),
  prepareCodexRolloutForResume: (...args) => prepareCodexRolloutForResume(...args),
  prepareExternalCodexSessionForResume: (...args) => prepareExternalCodexSessionForResume(...args),
});

/** Thread locations of the active owner, with the existing account-home layout. */
export function ownerCodexThreadLocations(): CodexThreadLocations {
  return storage.ownerCodexThreadLocations();
}

/** Read existing canonical history without adopting, copying or recording it. */
export async function readCodexThreadStorageReadOnly(threadId: string): Promise<
  { historyHome: string; sqliteHome: string; rolloutPath?: string } | undefined
> {
  return storage.readCodexThreadStorageReadOnly(threadId);
}

export async function prepareCodexResumeSession(threadId: string): Promise<string | undefined> {
  return storage.prepareCodexResumeSession(threadId);
}

export async function resolveCodexThreadStorage(threadId: string, options?: { readOnly?: boolean }) {
  return storage.resolveCodexThreadStorage(threadId, options);
}

export async function recordCodexThreadLocation(threadId: string, storageHome: string, rolloutPath?: string): Promise<void> {
  return storage.recordCodexThreadLocation(threadId, storageHome, rolloutPath);
}
