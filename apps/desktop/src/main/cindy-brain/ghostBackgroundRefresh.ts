import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginInstanceRegistry } from './pluginInstanceRegistry.js';

export interface GhostScanState {
  owner: string;
  mutation: object;
  identity: string;
}

export interface GhostBackgroundScan {
  ghosts: InstalledGhost[];
  registry: PluginInstanceRegistry;
  state: GhostScanState;
}

export interface GhostBackgroundRefresh {
  list(): Promise<InstalledGhost[]>;
  registry(): Promise<PluginInstanceRegistry>;
}

/** A single market refresh owns this view; no snapshot survives into the next refresh. */
export function createGhostBackgroundRefresh(deps: {
  state(): GhostScanState;
  scan(): Promise<GhostBackgroundScan>;
}): GhostBackgroundRefresh {
  const owner = deps.state().owner;
  let cached: GhostBackgroundScan | null = null;
  let flight: Promise<GhostBackgroundScan> | null = null;
  const current = () => {
    const state = deps.state();
    if (state.owner !== owner)
      throw new Error('ghost owner context changed during background refresh');
    return state;
  };
  const same = (a: GhostScanState, b: GhostScanState) =>
    a.owner === b.owner && a.mutation === b.mutation && a.identity === b.identity;
  const read = async <T>(project: (scan: GhostBackgroundScan) => T): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = current();
      if (cached && same(cached.state, state)) return project(cached);
      const pending = (flight ??= deps.scan());
      let scanned: GhostBackgroundScan;
      try {
        scanned = await pending;
      } finally {
        if (flight === pending) flight = null;
      }
      if (!same(scanned.state, current())) continue;
      cached = scanned;
      return project(scanned);
    }
    throw new Error('ghost installations changed repeatedly during background refresh');
  };
  return {
    list: () => read((scan) => scan.ghosts),
    registry: () => read((scan) => scan.registry),
  };
}
