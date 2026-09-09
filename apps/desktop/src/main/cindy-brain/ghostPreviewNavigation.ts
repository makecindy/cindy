import type { WebContents } from 'electron';

import type { GhostPreviewGate, GhostPreviewOutcome } from './previewGate.js';

export interface GhostPreviewNavigationLogger {
  debug(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
}

export interface GhostPreviewNavigationParams {
  ghostId: string;
  url: string;
  hostContents: WebContents;
  guestContents: WebContents;
}

export interface GhostPreviewNavigationDeps {
  request: GhostPreviewGate['request'];
  isOwnerActive(): boolean;
  send(outcome: Extract<GhostPreviewOutcome, { ok: true }>): void;
  logger: GhostPreviewNavigationLogger;
}

/**
 * Owner-aware preview continuation. The ledger lookup may finish after an
 * account commit, so the captured owner is checked both before and after it.
 */
export async function runGhostPreviewNavigation(
  params: GhostPreviewNavigationParams,
  deps: GhostPreviewNavigationDeps,
): Promise<void> {
  if (!deps.isOwnerActive()) return;
  try {
    const outcome = await deps.request({
      ghostId: params.ghostId,
      url: params.url,
      isPanelFocused: () =>
        deps.isOwnerActive() &&
        !params.guestContents.isDestroyed() &&
        params.guestContents.isFocused(),
    });
    if (!deps.isOwnerActive()) return;
    if (!outcome.ok) {
      deps.logger.debug('ghost preview rejected', {
        ghostId: params.ghostId,
        reason: outcome.reason,
      });
      return;
    }
    if (params.hostContents.isDestroyed()) return;
    if (!deps.isOwnerActive()) return;
    deps.send(outcome);
  } catch (error) {
    if (!deps.isOwnerActive()) return;
    deps.logger.warn('ghost preview failed', {
      ghostId: params.ghostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
