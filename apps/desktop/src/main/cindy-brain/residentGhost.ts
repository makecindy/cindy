import type { GhostManifest, InstalledGhost } from '../../shared/ghost.js';

/** Event publishers must listen after startup even when launch was omitted/on-demand. */
export function isResidentBrowserGhost(manifest: GhostManifest): boolean {
  return manifest.launch === 'resident' || manifest.routineEvents !== undefined;
}

/** Shared startup/enable/recovery path; runtime spawn retains its own authorization checks. */
export function spawnResidentGhost(ghost: InstalledGhost, deps: {
  isAvailable: (id: string) => boolean;
  startNode: (ghost: InstalledGhost) => Promise<unknown>;
  spawnBrowser: (ghost: InstalledGhost) => Promise<{ ok: boolean; reason?: string }>;
  warn: (message: string, fields: Record<string, unknown>) => void;
}): void {
  if (!ghost.enabled || !deps.isAvailable(ghost.manifest.id)) return;
  // Node residency remains an independent declaration; routine events do not expand it.
  if (ghost.manifest.node?.lifecycle === 'resident') {
    void deps.startNode(ghost).catch((error) => {
      deps.warn('resident ghost node spawn error', { id: ghost.manifest.id, error: String(error) });
    });
  }
  if (!isResidentBrowserGhost(ghost.manifest)) return;
  void deps.spawnBrowser(ghost).then((result) => {
    if (!result.ok) deps.warn('resident ghost spawn failed', { id: ghost.manifest.id, reason: result.reason });
  }).catch((error) => {
    deps.warn('resident ghost spawn error', { id: ghost.manifest.id, error: String(error) });
  });
}
