import { syncBotLinkedLanePermissions } from './botPermissionSync.js';
import { withBotPermissionChange } from './botPermissionDispatch.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';

const SESSION_PERMISSION_MODES = new Set([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

export function isSessionPermissionMode(mode: string): boolean {
  return SESSION_PERMISSION_MODES.has(mode);
}

/** Profile stores only the three teammate permission values. Other session modes stay on the session row. */
export function profilePermissionForSessionMode(mode: string): 'ask' | 'auto' | 'trusted' | null {
  if (mode === 'bypassPermissions') return 'trusted';
  if (mode === 'auto') return 'auto';
  if (mode === 'ask') return 'ask';
  return null;
}

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
