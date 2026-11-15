/** Owner/runtime-bound native history; no Desktop launcher imports. */
import path from 'node:path';
import { activeOwnerScopeKey, getActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import { CodexThreadLocations } from '../../../desktop/src/main/maker-host/codex-thread-locations.js';
import { createCodexLocalSessions } from '../../../desktop/src/main/maker-host/codexLocalSessionsCore.js';
import { createCodexThreadStorage } from '../../../desktop/src/main/maker-host/codexThreadStorageCore.js';
import type { createHostProviderConfig } from './provider-config.js';

export function createHostCodexThreadStorage(options: {
  profileDir: string;
  accounts: Pick<ReturnType<typeof createHostProviderConfig>['codexAccounts'], 'codexAccountHome'>;
  check(): void;
}) {
  const local = createCodexLocalSessions({
    // Check outside the common fallback too: a retired runtime must never fall
    // back to a system profile when its profile capability is no longer valid.
    assertCurrent: options.check,
    getUserDataDir: () => { options.check(); return options.profileDir; },
  });
  const storage = createCodexThreadStorage({
    activeOwnerScopeKey, getActiveAppSession, CodexThreadLocations,
    codexAccountHome: providerId => { options.check(); return options.accounts.codexAccountHome(providerId); },
    getCodexHome: () => { options.check(); return path.join(options.profileDir, 'codex-home'); },
    readCodexThreadStorageForArchiveAsync: local.readCodexThreadStorageForArchiveAsync,
    prepareCodexRolloutForResume: local.prepareCodexRolloutForResume,
    prepareExternalCodexSessionForResume: local.prepareExternalCodexSessionForResume,
  });
  const checkAfter = async <T>(run: () => Promise<T>): Promise<T> => {
    options.check();
    const result = await run();
    options.check();
    return result;
  };
  return {
    readCodexThreadStorageReadOnly: (threadId: string) => checkAfter(() => storage.readCodexThreadStorageReadOnly(threadId)),
    deps: {
      prepareCodexResumeSession: (threadId: string) => checkAfter(() => storage.prepareCodexResumeSession(threadId)),
      resolveCodexThreadStorage: (threadId: string, lookup?: { readOnly?: boolean }) => checkAfter(() => storage.resolveCodexThreadStorage(threadId, lookup)),
      recordCodexThreadLocation: (threadId: string, home: string, rolloutPath?: string) => checkAfter(() => storage.recordCodexThreadLocation(threadId, home, rolloutPath)),
    },
  };
}
