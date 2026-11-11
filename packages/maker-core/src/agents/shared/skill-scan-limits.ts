/**
 * Shared Skill namespace pruning policy.
 *
 * Skill discovery roots have a two-level structure at most:
 *   <discovery-root>/<namespace-or-author>/<skill>/
 * A direct child can also be a Skill itself. Never recurse deeper.
 *
 * Keep this module dependency-free so lightweight Desktop projection code can
 * import it without pulling the maker core graph.
 */

/** Common generated/dependency trees are not Skill namespaces. */
export const SKILL_SCAN_PRUNED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '__macosx',
  '__pycache__',
]);

/** Case-insensitive prune check so `DIST` / `Node_Modules` behave like their lowercase forms. */
export function shouldPruneSkillScanDirectory(name: string): boolean {
  return SKILL_SCAN_PRUNED_DIRS.has(name.toLowerCase());
}
