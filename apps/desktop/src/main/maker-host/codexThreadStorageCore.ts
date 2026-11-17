/** Canonical thread storage and the agent hooks, shared by Desktop and Node Host. */
import path from 'node:path';
import type { activeOwnerScopeKey } from '../appSessionState.js';
import type { CodexThreadLocations } from './codex-thread-locations.js';
import type { createCodexLocalSessions } from './codexLocalSessionsCore.js';

type LocalSessions = ReturnType<typeof createCodexLocalSessions>;
export interface CodexThreadStoragePorts {
  activeOwnerScopeKey: typeof activeOwnerScopeKey;
  getActiveAppSession(): { dataOwnerId: string | null };
  codexAccountHome(providerId: string): string;
  CodexThreadLocations: typeof CodexThreadLocations;
  getCodexHome(): string;
  readCodexThreadStorageForArchiveAsync: LocalSessions['readCodexThreadStorageForArchiveAsync'];
  prepareCodexRolloutForResume: LocalSessions['prepareCodexRolloutForResume'];
  prepareExternalCodexSessionForResume: LocalSessions['prepareExternalCodexSessionForResume'];
}

export function createCodexThreadStorage(ports: CodexThreadStoragePorts) {
  function ownerCodexThreadLocations(): CodexThreadLocations {
    return new ports.CodexThreadLocations(path.join(ports.codexAccountHome('thread-index'), 'locations'), ports.prepareCodexRolloutForResume);
  }

  async function readCodexThreadStorageReadOnly(threadId: string): Promise<
    { historyHome: string; sqliteHome: string; rolloutPath?: string } | undefined
  > {
    const owner = ports.activeOwnerScopeKey();
    const indexed = ports.getActiveAppSession().dataOwnerId
      ? await ownerCodexThreadLocations().readStorage(threadId) : undefined;
    if (owner !== ports.activeOwnerScopeKey()) throw new Error('Codex history owner changed');
    const storage = indexed ?? await ports.readCodexThreadStorageForArchiveAsync(threadId);
    if (owner !== ports.activeOwnerScopeKey()) throw new Error('Codex history owner changed');
    return storage;
  }

  async function prepareCodexResumeSession(threadId: string) {
    if (!ports.getActiveAppSession().dataOwnerId) return ports.prepareExternalCodexSessionForResume(threadId);
    return ownerCodexThreadLocations().prepareResume(threadId, ports.prepareExternalCodexSessionForResume);
  }

  async function resolveCodexThreadStorage(threadId: string, options?: { readOnly?: boolean }) {
    if (!ports.getActiveAppSession().dataOwnerId) return options?.readOnly ? readCodexThreadStorageReadOnly(threadId) : undefined;
    const ownerScope = ports.activeOwnerScopeKey();
    const storage = options?.readOnly
      ? await readCodexThreadStorageReadOnly(threadId)
      : await ownerCodexThreadLocations().readStorage(threadId, {
      home: ports.getCodexHome(),
      prepare: ports.prepareExternalCodexSessionForResume,
    });
    if (ports.activeOwnerScopeKey() !== ownerScope) throw new Error('Codex history owner changed during preparation');
    return storage;
  }

  async function recordCodexThreadLocation(threadId: string, storageHome: string, rolloutPath?: string) {
    if (!rolloutPath || !ports.getActiveAppSession().dataOwnerId) return;
    await ownerCodexThreadLocations().record(threadId, rolloutPath, storageHome);
  }

  return { ownerCodexThreadLocations, readCodexThreadStorageReadOnly,
    prepareCodexResumeSession, resolveCodexThreadStorage, recordCodexThreadLocation };
}
