/**
 * Persists the most-recently-used Ghost ids for Plugin launcher ordering.
 *
 * The manifest remains publisher-owned; this host-owned interaction history lives in a
 * dedicated electron-store file shared by dev and packaged builds.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import Store from 'electron-store';

import { isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

interface GhostRecentUsageShape {
  ids: string[];
}

const MAX_RECENT_GHOST_IDS = 100;

let storeInstance: Store<GhostRecentUsageShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<GhostRecentUsageShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<GhostRecentUsageShape>({
      name: 'ghost-recent-usage',
      cwd: currentPath,
      defaults: { ids: [] },
      schema: { ids: { type: 'array', items: { type: 'string' } } },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

/** Cleans persisted history while preserving its newest-first order. */
export function normalizeGhostRecentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isGhostInstanceId(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    ids.push(candidate);
    if (ids.length >= MAX_RECENT_GHOST_IDS) break;
  }
  return ids;
}

export function loadGhostRecentIds(): string[] {
  return normalizeGhostRecentIds(getStore().get('ids', []));
}

/** Moves one installed Ghost to the front without accumulating duplicates. */
export function markGhostRecentlyUsed(id: string): string[] {
  const next = [id, ...loadGhostRecentIds().filter((candidate) => candidate !== id)].slice(
    0,
    MAX_RECENT_GHOST_IDS,
  );
  getStore().set('ids', next);
  return next;
}

/** Removes stale history when a Plugin is explicitly uninstalled. */
export function forgetGhostRecentUsage(id: string): string[] {
  const next = loadGhostRecentIds().filter((candidate) => candidate !== id);
  getStore().set('ids', next);
  return next;
}
