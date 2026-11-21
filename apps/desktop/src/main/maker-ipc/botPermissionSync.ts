import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { createBotPermissionSync } from './botPermissionSyncCore.js';

// The lane sync (botPermissionSyncCore.ts) bound to the desktop's Maker host and patch broadcast, both read
// at call time as the moved code read its imports.
const sync = createBotPermissionSync({
  getMakerIfReady: () => getMakerIfReady(),
  broadcastSessionPatched: (sessionId, patch) => broadcastSessionPatched(sessionId, patch),
});

/** Follow committed values under the same fence as explicit permission changes. */
export async function syncBotLanePermission(sessionId: string): Promise<void> {
  return sync.syncBotLanePermission(sessionId);
}

/** Called after a canonical save; delegated work and archived history keep their own authority. */
export async function syncBotLinkedLanePermissions(canonicalSessionId: string): Promise<void> {
  return sync.syncBotLinkedLanePermissions(canonicalSessionId);
}

/** Settings can outlive a missing canonical link; those live lanes still need tightening. */
export async function syncBotPermissionsByBotId(botId: string, excludedSessionId = ''): Promise<void> {
  return sync.syncBotPermissionsByBotId(botId, excludedSessionId);
}
