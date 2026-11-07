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
  const path = String(raw);
  if (path.trim() === '') return null;

  const withoutLongPathPrefix = stripWindowsLongPathPrefix(path);
  const outNeedsWindowsSeparatorRewrite =
    isWindowsPathLike(path) || isWindowsPathLike(withoutLongPathPrefix);
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
 * 工作目录的比较键，不用于文件访问，也不折叠独立 worktree。
 *
 * 先按 storage 规则归一化(Windows 分隔符 / 长路径前缀 / 尾部斜杠),Windows 盘符与
 * UNC 路径再按大小写不敏感比较 —— Windows 文件系统大小写不敏感,而用户从目录选择器
 * 拿到的拼写(盘符大小写、`\` vs `/`)常常与库里存的值不同。POSIX 下反斜杠是合法
 * 文件名字符、大小写敏感,不折叠。
 *
 * `windows` 默认取当前进程平台;renderer 没有 `process` 时应由调用方传入
 * (`window.electronAPI.platform === 'win32'`)。
 */
export function workingDirComparisonKey(
  raw: string | null | undefined,
  options: { windows?: boolean } = {},
): string | null {
  const normalized = normalizeWorkingDirForStorage(raw);
  if (normalized === null) return null;
  const windows =
    options.windows ?? (typeof process !== 'undefined' && process.platform === 'win32');
  return windows && isWindowsPathLike(normalized) ? normalized.toLowerCase() : normalized;
}

/** Comparison only: keep the original path for display/IO, and do not collapse worktrees. */
export function workingDirEquals(
  left: string | null | undefined,
  right: string | null | undefined,
  options: { windows?: boolean } = {},
): boolean {
  const a = workingDirComparisonKey(left, options);
  const b = workingDirComparisonKey(right, options);
  return a !== null && b !== null && a === b;
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

/** 搜索比较键：保留分组结果的原始拼写用于展示，只有比较时才折叠 Windows 大小写。 */
export function normalizeWorkingDirForComparison(raw: string | null | undefined): string | null {
  const collapsed = normalizeWorkingDirForGrouping(raw);
  return collapsed && isWindowsPathLike(collapsed) ? collapsed.toLowerCase() : collapsed;
}

export function stripWindowsLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

/** 盘符路径或 UNC(`\\server` / `//server`)——按 Windows 规则归一的判据。 */
export function isWindowsPathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}
