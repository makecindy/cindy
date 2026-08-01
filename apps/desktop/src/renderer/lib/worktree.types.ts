/**
 * worktree types — renderer 侧镜像，与 main/worktree/types.ts 字段一致。
 *
 * worktree-parallel-sessions 前端方案 M1：
 * renderer 不持有 worktree 副作用，所有创建 / 探测均通过 IPC 委托给 main。
 * 这里只声明 IPC 跨进程的请求 / 响应类型，不引入任何运行时行为。
 */

export interface WorktreeMeta {
  sessionId: string;
  /** 形如 `pensive-lederberg`，由 main 侧生成或用户输入。 */
  name: string;
  /** worktree 在磁盘上的绝对路径。 */
  path: string;
  /** baseRepo 根目录绝对路径（创建时所在 session 的 workingDir）。 */
  baseRepo: string;
  /** main 侧固定前缀的分支名 `xdt/<name>`。 */
  branch: string;
  /** 用户在创建时选择的源分支（如 `main`）。 */
  sourceBranch: string;
  /** ISO 8601 时间字符串。 */
  createdAt: string;
  /** 隔离回收期间的实际路径；正常 worktree 不设置。 */
  quarantinePath?: string;
}

/**
 * 6 类已知错误 + unknown 兜底。每类都会被 worktreeToast 翻译成
 * 用户可读的中文文案 + hint（设计稿 F5）。
 */
export type WorktreeErrorKind =
  | 'permission-denied'
  | 'git-crypt-locked'
  | 'dubious-ownership'
  | 'lfs-error'
  | 'not-a-git-repo'
  | 'git-not-installed'
  | 'unknown';

export interface WorktreeError {
  kind: WorktreeErrorKind;
  /** 用户可见的标题。 */
  message: string;
  /** 用户可见的辅助说明 / 修复建议。 */
  hint?: string;
  /** 原始 stderr，仅 unknown 类型会回显。 */
  rawStderr?: string;
}

export interface CreateWorktreeReq {
  sessionId: string;
  baseRepo: string;
  name: string;
  sourceBranch: string;
}

export type CreateWorktreeResp =
  | { ok: true; meta: WorktreeMeta }
  | { ok: false; error: WorktreeError };

export interface DetectCwdResp {
  isGitRepo: boolean;
  isInsideWorktree: boolean;
  gitInstalled: boolean;
  currentBranch?: string;
  /** 仓库根（可能与传入 cwd 不同）。 */
  repoRoot?: string;
  /** 被控端是否支持 recoveryKey 预创建回收；旧端省略该字段。 */
  supportsRecoveryKeyDiscard?: boolean;
}

export interface ListBranchesResp {
  branches: string[];
  /** 当前 HEAD 所在分支名（用于默认值）。 */
  current: string;
}

export interface SuggestNameResp {
  name: string;
}

export interface RevealResp {
  ok: boolean;
  /** 仅 ok=false 时可能存在: 路径不在白名单 / shell 失败 等原因。 */
  error?: WorktreeError;
}
