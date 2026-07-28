import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';

import { getManagedWorktreeBasePath } from './managedWorktreePaths';

/**
 * workingDir helpers shared by main, preload, and renderer.
 *
 * Storage normalization keeps one canonical spelling for the same physical
 * directory. Grouping normalization additionally returns a comparison/grouping
 * key only; callers that need to access files must keep using the session cwd.
 */

/**
 * Normalize a session workingDir before storing it in local DB / drafts.
 *
 * - null / undefined / blank -> null
 * - Windows long-path prefix is removed
 * - Windows path separators become forward slashes
 * - trailing slashes are removed, except filesystem roots
 */
export function normalizeWorkingDirForStorage(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;

  const withoutLongPathPrefix = stripWindowsLongPathPrefix(trimmed);
  const outNeedsWindowsSeparatorRewrite =
    isWindowsPathLike(trimmed) || isWindowsPathLike(withoutLongPathPrefix);
  let out = outNeedsWindowsSeparatorRewrite
    ? withoutLongPathPrefix.replace(/\\/g, '/')
    : withoutLongPathPrefix;
  while (out.length > 1 && out.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(out)) break;
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Normalize the directory used to read or write project settings.
 *
 * Cindy-managed worktrees inherit settings from their base repository.
 * Imported or user-managed worktrees keep their runtime cwd because they may
 * intentionally carry a distinct .claude/settings.json.
 */
export function normalizeWorkingDirForProjectSettings(
  raw: string | null | undefined,
): string | null {
  const out = normalizeWorkingDirForStorage(raw);
  if (out == null) return null;
  return getManagedWorktreeBasePath(out) ?? out;
}

/**
 * Normalize a session workingDir for broad project grouping and equality
 * checks. Project-settings normalization is applied first, then conventional
 * user-managed worktree paths also collapse to their base repo.
 */
export function normalizeWorkingDirForGrouping(raw: string | null | undefined): string | null {
  const out = normalizeWorkingDirForProjectSettings(raw);
  if (out == null) return null;

  return collapseWorktreeDirForGrouping(out);
}

function stripWindowsLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

function isWindowsPathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}
