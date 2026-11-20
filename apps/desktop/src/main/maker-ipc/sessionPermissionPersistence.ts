import { syncBotLinkedLanePermissions } from './botPermissionSync.js';
import { withBotPermissionChange } from './botPermissionDispatch.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { isSessionPermissionMode } from './sessionPermissionModes.js';

export { isSessionPermissionMode, profilePermissionForSessionMode } from './sessionPermissionModes.js';

/**
 * Persist a permission change when the Maker runtime is not loaded.
 * Returns false only when the mode is invalid or the session row does not exist.
 */
export async function persistPermissionModeWithoutRuntime(
  sessionId: string,
  mode: string,
): Promise<boolean> {
  if (!isSessionPermissionMode(mode)) return false;
  const owner = getCurrentDbClientSnapshot();
  if (!owner) throw new Error('DbClient not ready');
  return withBotPermissionChange(sessionId, async () => {
    const saved = await owner.client.tx('bots.persistSessionPermission', { sessionId, mode });
    if (getCurrentDbClientSnapshot() !== owner) throw new Error('Account changed during permission update');
    if (saved.updated) await syncBotLinkedLanePermissions(sessionId);
    return saved.updated;
  });
}
