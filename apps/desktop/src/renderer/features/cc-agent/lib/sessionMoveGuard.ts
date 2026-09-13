/**
 * 会话移动守卫:worktree 会话的工作区边界就是它自己的 worktree。
 *
 * 「移动到项目 / 选择项目文件夹」只改 `sessions.working_dir`,而会话绑定的 worktree
 * (目录、分支、store 归属与回收义务)不会跟着走:一旦允许改到别处,侧栏按新项目归组,
 * 聊天框底部路径、Git 上下文与 worktree 徽标却仍指旧 worktree,形成「半移动」。
 * 完整的 worktree → Local Handoff 是独立特性(#2190 / #2585,需显式处置未提交改动),
 * 在它落地前 GUI 与 Main(`local-db:sessions:update`)同口径拒绝。
 *
 * 判据只认 **Cindy 托管 worktree**(`.cindy-worktrees` / `.xdt-worktrees`)——用户自建的
 * `.worktrees` 不在 Cindy 生命周期内,移动它不构成归属分裂。含 worktree 的子目录。
 */

import { managedWorktreeBaseRepo } from '@cindy/maker-shared/worktree-paths';

/**
 * 该 workingDir 是否落在 Cindy 托管 worktree 内(Cindy 托管根本身或其子目录)。
 * 只做纯字符串判定,不碰文件系统;`working_dir` 缺失时返回 false。
 */
export function isManagedWorktreeWorkingDir(workingDir: string | null | undefined): boolean {
  if (typeof workingDir !== 'string' || workingDir.length === 0) return false;
  return managedWorktreeBaseRepo(workingDir) !== null;
}
