/**
 * worktree-parallel-sessions: 把 git/fs 错误映射到 6 类已知 + unknown。
 *
 * 规则按顺序匹配, 先 match 先返回(顺序就是优先级)。unknown 是最终兜底。
 *
 * 与 tech_spec M2 表对齐:
 *   git-not-installed | not-a-git-repo | dubious-ownership | permission-denied
 *   | git-crypt-locked | lfs-error | unknown
 */

import type { WorktreeError, WorktreeErrorKind } from "./types.js";

export interface ClassifyInput {
  /** 失败命令的 stderr 文本(可能为空)。 */
  stderr?: string;
  /** 子进程 exit code, spawn 失败为 null。 */
  exitCode?: number | null;
  /** 原始 Error 对象, ENOENT/EACCES 等 errno 用得上。 */
  cause?: unknown;
}

interface NodeErrno {
  code?: string;
  syscall?: string;
  path?: string;
  errno?: number;
}

function getErrno(cause: unknown): NodeErrno | null {
  if (typeof cause !== "object" || cause === null) return null;
  const c = cause as NodeErrno;
  if (typeof c.code !== "string") return null;
  return c;
}

/**
 * 从 stderr 里抠出来的路径 / 文件名 / token(用于 message 拼接)。
 * 当前不在 message 里展示具体路径, 保持简洁; 调试用 raw stderr 看完整。
 */
function summarize(stderr: string, max = 200): string {
  return stderr.trim().slice(0, max);
}

export function classifyError(input: ClassifyInput): WorktreeError {
  const stderr = input.stderr ?? "";
  const errno = getErrno(input.cause);

  // 1. git-not-installed: spawn ENOENT (errno.code === 'ENOENT' 且原命令是 git)
  //    我们的 gitExec 包装层会把 spawn 失败的 errno 透传到 cause; classifier 仅靠 errno 判断
  if (
    errno?.code === "ENOENT" &&
    (errno.syscall === "spawn git" || stderr === "")
  ) {
    return {
      kind: "git-not-installed",
      message: "未检测到 git 命令",
      hint: "请先安装 git(https://git-scm.com/downloads)后重试",
    };
  }

  // 2. not-a-git-repo
  if (/not a git repository/i.test(stderr)) {
    return {
      kind: "not-a-git-repo",
      message: "当前目录不是 git 仓库",
      hint: "请切换到 git 仓库根目录后重试",
    };
  }

  // 3. dubious-ownership(gitExec 已经自动重试过仍失败 → 抛到这层)
  if (/dubious ownership|safe\.directory/i.test(stderr)) {
    return {
      kind: "dubious-ownership",
      message: "git 拒绝信任此目录",
      hint: "已自动加入 safe.directory, 请重试; 若仍失败请检查目录所有者",
    };
  }

  // 4. git-crypt-locked: 必须在 lfs 之前, 关键词组合保证不误伤
  if (
    /git-crypt|encrypted/i.test(stderr) &&
    /unable to|locked|cannot/i.test(stderr)
  ) {
    return {
      kind: "git-crypt-locked",
      message: "文件被 git-crypt 加密, 当前 worktree 无法访问",
      hint: "请先 git-crypt unlock 后重试",
    };
  }

  // 5. lfs-error
  if (/git-lfs|smudge error|lfs:/i.test(stderr)) {
    return {
      kind: "lfs-error",
      message: "LFS 操作失败",
      hint: "请检查 git-lfs 安装与认证(git lfs install / git lfs pull)",
    };
  }

  // 6. permission-denied: errno 优先, 其次 stderr 关键词
  if (
    errno?.code === "EACCES" ||
    errno?.code === "EPERM" ||
    errno?.code === "EBUSY" ||
    /permission denied|operation not permitted|is being used by another process|access is denied/i.test(
      stderr,
    )
  ) {
    return {
      kind: "permission-denied",
      message: "文件或目录权限不足或被占用",
      hint: "请关闭可能占用文件的程序(编辑器/终端/杀毒软件)后重试",
    };
  }

  // 兜底: unknown — UI 直接展示原始 stderr
  return {
    kind: "unknown",
    message: "操作失败",
    rawStderr:
      summarize(stderr) ||
      (input.cause instanceof Error ? input.cause.message : ""),
  };
}

/** 仅供测试 / 调试: 返回当前已知的 kind 全集。 */
export const ALL_ERROR_KINDS: readonly WorktreeErrorKind[] = [
  "git-not-installed",
  "not-a-git-repo",
  "dubious-ownership",
  "git-crypt-locked",
  "lfs-error",
  "permission-denied",
  "unknown",
];
