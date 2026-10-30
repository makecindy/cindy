import { isLibraryExtraDirSlot } from './extraDirsValidator.js';

/** Keep revocation/rebuilt runtimes, without rewriting every dormant task on focus. */
export function libraryExtraDirSyncTargets(
  rows: ReadonlyArray<{ id: string; extraDirs: string | null }>,
  liveIds: ReadonlySet<string>,
  focused: string | null,
): Set<string> {
  const targets = new Set<string>();
  for (const row of rows) {
    if (liveIds.has(row.id)) {
      targets.add(row.id);
      continue;
    }
    try {
      const dirs: unknown = JSON.parse(row.extraDirs ?? '[]');
      if (Array.isArray(dirs) && dirs.some((dir) => typeof dir === 'string' && isLibraryExtraDirSlot(dir))) {
        targets.add(row.id);
      }
    } catch {
      // Preserve normal validation for malformed legacy grant data.
      targets.add(row.id);
    }
  }
  // Runtime lifetime is independent of DB visibility/status. A live archived or
  // hidden task must still revoke its old Library slot when focus changes.
  for (const id of liveIds) targets.add(id);
  if (focused) targets.add(focused);
  return targets;
}
