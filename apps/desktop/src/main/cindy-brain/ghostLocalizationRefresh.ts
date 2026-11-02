import { ghostAppContextLanguages, type GhostAppRegion } from '../../shared/ghost.js';
import type { SupportedLocale } from '../../shared/locale.js';

// types
export interface GhostLocalizationRefreshDeps<G> {
  region: GhostAppRegion;
  /** Host locale in effect before this change (captured before it is overwritten). */
  previousLocale: SupportedLocale;
  currentLocale: SupportedLocale;
  list: () => G[];
  broadcastChanged: (ghosts: G[]) => void;
  sendContextChanged: (ghost: G, message: Record<string, unknown>) => void;
}

// refresh
/** Notify installed plugins that the host app-context changed. */
export function refreshGhostLocalizationIfChanged<G>(deps: GhostLocalizationRefreshDeps<G>): boolean {
  const ghosts = deps.list();
  deps.broadcastChanged(ghosts);
  const context = {
    ok: true as const,
    context: { region: deps.region, ...ghostAppContextLanguages(deps.currentLocale) },
  };
  for (const ghost of ghosts) {
    deps.sendContextChanged(ghost, { type: 'host-context-changed', ...context });
  }
  return true;
}
