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
 * 两个工作目录是否指向同一位置。
 *
 * 先按 storage 规则归一化(Windows 分隔符 / 长路径前缀 / 尾部斜杠),Windows 盘符与
 * UNC 路径再按大小写不敏感比较 —— Windows 文件系统大小写不敏感,而用户从目录选择器
 * 拿到的拼写(盘符大小写、`\` vs `/`)常常与库里存的值不同。POSIX 下反斜杠是合法
 * 文件名字符、大小写敏感,不折叠。
 *
 * `windows` 默认取当前进程平台;renderer 没有 `process` 时应由调用方传入
 * (`window.electronAPI.platform === 'win32'`)。
 */
export function workingDirEquals(
  left: string | null | undefined,
  right: string | null | undefined,
  options: { windows?: boolean } = {},
): boolean {
  const a = normalizeWorkingDirForStorage(left);
  const b = normalizeWorkingDirForStorage(right);
  if (a === null || b === null) return false;
  if (a === b) return true;
  const windows =
    options.windows ?? (typeof process !== 'undefined' && process.platform === 'win32');
  if (!windows) return false;
  const caseFoldable = (value: string): boolean =>
    /^[A-Za-z]:\//.test(value) || value.startsWith('//');
  return caseFoldable(a) && caseFoldable(b) && a.toLowerCase() === b.toLowerCase();
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
