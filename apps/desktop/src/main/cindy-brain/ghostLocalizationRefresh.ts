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
/**
 * Notify installed plugins only when the app-context they can see changed.
 * Compares the plugin-visible fields (locale + uiLocale), not the host locale:
 * several host locales map to the same protocol locale. Region is a fixed
 * build identity, so it cannot differ between the two sides.
 */
export function refreshGhostLocalizationIfChanged<G>(deps: GhostLocalizationRefreshDeps<G>): boolean {
  const before = ghostAppContextLanguages(deps.previousLocale);
  const after = ghostAppContextLanguages(deps.currentLocale);
  if (before.locale === after.locale && before.uiLocale === after.uiLocale) return false;
  const ghosts = deps.list();
  deps.broadcastChanged(ghosts);
  const context = {
    ok: true as const,
    context: { region: deps.region, ...after },
  };
  for (const ghost of ghosts) {
    deps.sendContextChanged(ghost, { type: 'host-context-changed', ...context });
  }
  return true;
}
