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
  readonly onUninstallSourceState?: (fromPart: string) => Promise<void>;
}

/** One manager per process: the receipt store memoizes owner-scoped roots. */
let cached: { key: string; manager: GhostManager } | null = null;

export function hostGhostManager(options: HostGhostManagerOptions): GhostManager {
  const ownerKey = dataOwnerStorageKey(options.ownerId);
  const key = `${options.userDataDir}\u0000${ownerKey}`;
  if (cached?.key === key) return cached.manager;
  cached?.manager.disposeNotificationIndex();
  const manager = createHostGhostManager(options);
  cached = { key, manager };
  return manager;
}

/** Runtime-owned manager; released with its owner, never a cached callback from
 * a previous login generation. The listing helper remains read-only. */
export function createHostGhostManager(options: HostGhostManagerOptions): GhostManager {
  const ownerKey = dataOwnerStorageKey(options.ownerId);
  const ownerRoot = path.join(options.userDataDir, 'owners', ownerKey);
  const manager = new GhostManager({
    getRootDir: () => path.join(ownerRoot, 'cindy-brain'),
    getStateDir: () => path.join(ownerRoot, 'ghost-install-state'),
    getOwnerContextKey: () => ownerKey,
    getLocale: () => 'en',
    // A listing-only caller has no vault. Keep the existing journal isolated
    // until the runtime can revoke references; never delete first and forget it.
    onUninstallSourceState: options.onUninstallSourceState ?? (async () => {
      throw new Error('Plugin account cleanup is unavailable');
    }),
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
  });
  return manager;
}

export async function listInstalledGhosts(options: HostGhostManagerOptions): Promise<InstalledGhost[]> {
  return hostGhostManager(options).listAsync();
}
