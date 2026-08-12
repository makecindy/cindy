/**
 * worktree-parallel-sessions: 类型契约。
 *
 * IPC 边界类型（main ↔ renderer 共识），renderer 侧 mirror 在
 * `apps/desktop/src/renderer/lib/worktree.types.ts`（前端方案 T1 文件）。
 */

/**
 * worktree 元信息，electron-store 中按 sessionId → meta 单条索引。
 * 同时也是 sessions.worktree_path 反范式快照的来源。
 */
export interface WorktreeMeta {
  sessionId: string;
  /** 用户输入或 nameGenerator 给的名字（用于显示 + 路径段 + 分支段）。 */
  name: string;
  /** worktree 绝对路径；新建位于 .cindy-worktrees，历史记录也可能位于 .xdt-worktrees。 */
  path: string;
  /** 创建 worktree 时所在的 git repo 根目录（cwd）。 */
  baseRepo: string;
  /** 托管分支名；新建为 `cindy/<name>`，历史记录也可能为 `xdt/<name>`。回收目录时分支保留。 */
  branch: string;
  /** 用户在 worktree 创建表单选择的源分支（git worktree add -b <branch> <path> <sourceBranch>）。 */
  sourceBranch: string;
  /** ISO 8601 创建时间。 */
  createdAt: string;
  /**
   * 手机端在远程落盘前持久化的随机恢复关联键。只用于证明一次预创建恢复请求
   * 对应本记录；不授予通用删除能力。
   */
  recoveryKey?: string;
  /**
   * 隔离回收期间的实际 worktree 路径。保留原 path 作为外部账本的稳定定位，
   * 进程崩溃后可从该字段继续回收 quarantine 目录。
   */
  quarantinePath?: string;
  /** true = scheduler 创建的临时 worktree，session 关闭时可池化复用而非销毁。 */
  ephemeral?: boolean;
}

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
  /** 中文，可直接展示给用户。 */
  message: string;
  /** 建议操作；unknown 类型不带 hint，由 UI 直接展示原始 stderr。 */
  hint?: string;
  /** unknown 类型时透传原始 stderr 给 UI 渲染。 */
  rawStderr?: string;
}

// ── IPC schemas ────────────────────────────────────────────────────────────

export interface CreateWorktreeReq {
  sessionId: string;
  baseRepo: string;
  name: string;
  sourceBranch: string;
  /** 远程两步创建的恢复关联键；本机普通创建不传。 */
  recoveryKey?: string;
  /** 标记为 ephemeral worktree（scheduler 用），session 关闭时可池化复用。 */
  ephemeral?: boolean;
}

export type CreateWorktreeResp =
  { ok: true; meta: WorktreeMeta } | { ok: false; error: WorktreeError };

export interface DetectCwdReq {
  cwd: string;
}

export interface DetectCwdResp {
  isGitRepo: boolean;
  isInsideWorktree: boolean;
  gitInstalled: boolean;
  currentBranch?: string;
  /** git rev-parse --show-toplevel 的结果，绝对路径。 */
  repoRoot?: string;
  /**
   * 当前被控端是否会把 recoveryKey 持久化到 worktree 元数据，并支持按键回收。
   * 旧 Desktop 会省略该字段；控制端必须在创建副作用前把省略视为不支持。
   */
  supportsRecoveryKeyDiscard?: boolean;
}

export interface ListBranchesReq {
  baseRepo: string;
}

export interface ListBranchesResp {
  branches: string[];
  current: string;
}

export interface SuggestNameReq {
  baseRepo: string;
}

export interface SuggestNameResp {
  name: string;
}

export interface RevealReq {
  path: string;
}

export interface RevealResp {
  ok: boolean;
  /** 仅 ok=false 时可能存在: 路径不在白名单 / shell 失败 等原因。 */
  error?: WorktreeError;
}
