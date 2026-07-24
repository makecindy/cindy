import type { GhostSetupAllowedAction } from '../../shared/ghost.js';

export type GhostSetupNavigationTarget =
  | { target: 'plugin_settings'; ghostId: string }
  | { target: 'client_settings' };

/**
 * Maps a validated Host action to a fixed local route payload. The ghost id
 * always comes from the pending waiter, never from the opaque action id.
 */
export function ghostSetupNavigationForAction(
  ghostId: string,
  action: GhostSetupAllowedAction,
): GhostSetupNavigationTarget | null {
  if (action.kind === 'open_client_settings') {
    return { target: 'client_settings' };
  }
  if (action.kind === 'open_plugin_settings' || action.kind === 'manage_connection') {
    return { target: 'plugin_settings', ghostId };
  }
  return null;
}
