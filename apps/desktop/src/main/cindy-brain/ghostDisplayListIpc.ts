import type { InstalledGhost } from '../../shared/ghost.js';

/** Display-only recovery; runtime capability checks must never consume this cache. */
export function createGhostDisplayListHandler(deps: {
  scopeKey(): string;
  isBoundaryPending(): boolean;
  list(): InstalledGhost[];
  isScanComplete(): boolean;
  warn(): void;
}): () => { ghosts: InstalledGhost[] } {
  let cached: { scope: string; ghosts: InstalledGhost[] } | null = null;
  return () => {
    if (deps.isBoundaryPending()) {
      cached = null;
      return { ghosts: [] };
    }
    const scope = deps.scopeKey();
    const previous = cached?.scope === scope ? cached.ghosts : null;
    const stillCurrent = () => !deps.isBoundaryPending() && deps.scopeKey() === scope;
    try {
      const ghosts = deps.list();
      if (!stillCurrent()) {
        cached = null;
        return { ghosts: [] };
      }
      if (deps.isScanComplete()) {
        cached = { scope, ghosts };
        return { ghosts };
      }
      return { ghosts: previous ?? ghosts };
    } catch {
      deps.warn();
      return { ghosts: stillCurrent() ? previous ?? [] : [] };
    }
  };
}
