/**
 * Cindy 托管 worktree 的目录名与 base repo 解析。
 *
 * 事实源在 `@cindy/maker-shared/worktree-paths` —— 手机端的项目分组要用同一套折叠口径,
 * 词表分叉会让两端对「这是哪个项目」给出不同答案。本文件只保留桌面侧的历史导出名。
 */
import { managedWorktreeBaseRepo } from '@cindy/maker-shared/worktree-paths';

export {
  isManagedWorktreeDirectoryName,
  LEGACY_MANAGED_WORKTREE_DIR_NAME,
  MANAGED_WORKTREE_DIR_NAME,
  MANAGED_WORKTREE_DIR_NAMES,
} from '@cindy/maker-shared/worktree-paths';

/**
 * 从已经过 storage normalization 的路径中解析 Cindy 托管 worktree 的 base repo。
 * 找不到完整的 `<root>/<managed-dir>/<name>` 形态时返回 null。
 */
export function getManagedWorktreeBasePath(normalizedPath: string): string | null {
  return managedWorktreeBaseRepo(normalizedPath);
}
