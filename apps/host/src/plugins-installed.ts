/**
 * Installed plugin projection for the host.
 *
 * Reuses the desktop's `GhostManager` — the same implementation, constructed with
 * the host's owner-scoped roots instead of Electron's. Listing is read-only; the
 * security-sensitive adapters (market ledger, namespace migration, resident
 * spawning) stay at their defaults, which fail closed.
 */

import path from 'node:path';

import { GhostManager } from '../../desktop/src/main/cindy-brain/GhostManager.ts';
import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import type { InstalledGhost } from '../../desktop/src/shared/ghost.ts';

export interface HostGhostManagerOptions {
  readonly userDataDir: string;
  readonly ownerId: string;
  readonly onChanged?: (ghosts: InstalledGhost[]) => void;
}

/** One manager per process: the receipt store memoizes owner-scoped roots. */
let cached: { key: string; manager: GhostManager } | null = null;

export function hostGhostManager(options: HostGhostManagerOptions): GhostManager {
  const ownerKey = dataOwnerStorageKey(options.ownerId);
  const key = `${options.userDataDir}\u0000${ownerKey}`;
  if (cached?.key === key) return cached.manager;
  const ownerRoot = path.join(options.userDataDir, 'owners', ownerKey);
  const manager = new GhostManager({
    getRootDir: () => path.join(ownerRoot, 'cindy-brain'),
    getStateDir: () => path.join(ownerRoot, 'ghost-install-state'),
    getOwnerContextKey: () => ownerKey,
    getLocale: () => 'en',
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
  });
  cached = { key, manager };
  return manager;
}

export async function listInstalledGhosts(options: HostGhostManagerOptions): Promise<InstalledGhost[]> {
  return hostGhostManager(options).listAsync();
}
