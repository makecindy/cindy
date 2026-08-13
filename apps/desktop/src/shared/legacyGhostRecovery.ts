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
  /** Discovery could not establish the complete legacy source set yet. */
  deferredReason?: 'legacy-discovery-incomplete';
}

export const NO_LEGACY_GHOST_RECOVERY: LegacyGhostRecoveryStatus = {
  state: 'none',
  legacyPluginCount: 0,
  canRetry: false,
};
