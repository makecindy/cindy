/**
 * Renderer-safe projection of the legacy Plugin namespace recovery state.
 *
 * Main intentionally exposes only a coarse status and a count. Owner ids,
 * filesystem paths, manifests, settings, and credentials never cross IPC.
 */
export type LegacyGhostRecoveryState = 'none' | 'deferred' | 'partial' | 'claimed-by-other-owner';

export interface LegacyGhostRecoveryStatus {
  state: LegacyGhostRecoveryState;
  legacyPluginCount: number;
  canRetry: boolean;
}

export const NO_LEGACY_GHOST_RECOVERY: LegacyGhostRecoveryStatus = {
  state: 'none',
  legacyPluginCount: 0,
  canRetry: false,
};
