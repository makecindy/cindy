export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export class GitExecError extends Error {
  /** 原 git 命令(args 数组)。 */
  readonly args: readonly string[];
  /** git 子进程的 exit code, ENOENT 等 spawn 失败时为 null。 */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  /** 原始底层错误对象, spawn ENOENT 等用得上。 */
  readonly cause?: NodeJS.ErrnoException;
  /** 超时是未知状态，探测调用方不得把它当作「目录不存在」。 */
  readonly timedOut: boolean;

  constructor(opts: {
    args: readonly string[];
    exitCode: number | null;
    stderr: string;
    stdout: string;
    cause?: NodeJS.ErrnoException;
    timedOut?: boolean;
  }) {
    super(
      `git ${opts.args.join(" ")} failed${
        opts.exitCode === null
          ? " (spawn error)"
          : ` with exit code ${opts.exitCode}`
      }: ${opts.stderr.trim() || opts.cause?.message || "<no stderr>"}`,
    );
    this.name = "GitExecError";
    this.args = opts.args;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdout = opts.stdout;
    this.cause = opts.cause;
    this.timedOut = opts.timedOut ?? false;
  }
}

export interface GitExecOpts {
  /** 额外的环境变量, 会与 process.env 合并(后者优先级低)。常见: { LC_ALL: 'C' } */
  extraEnv?: Record<string, string>;
  /**
   * 超时毫秒数, 到点终止 git 的**整棵进程树**并让 Promise 以 GitExecError 稳定
   * 收口(execFile 内建 timeout 只 SIGTERM 直接的 git 进程, 卡住的 git-remote-http
   * 或 credential helper 后代会带着继承的 stdio 活下来——既拖过 deadline 又留
   * 孤儿进程)。Windows 走 proc-util killProcessTree 的 taskkill /T /F(带重试与
   * 后代兜底); POSIX 让 git 以 detached 自成进程组长, deadline 处对整组 SIGTERM
   * (git 收 TERM 会清理 .lock), 等**进程组清空**后才收口(直接 git 进程退出 ≠
   * 组清空, 幸存的 git-remote-http 或 credential helper 后代仍可能持锁), 宽限期
   * 内未清空的
   * 由整组 SIGKILL 兜底后再收口。两个平台都保证收口时进程树已终止——调用方拿到
   * 超时错误后立刻发起的下一个 git 操作不会与残留进程争抢同一仓库的 .lock。
   * 省略 = 不超时。
   */
  timeoutMs?: number;
  /** Optional absolute performance.now() deadline shared by ownership repair and retries. */
  deadlineAtMs?: number;
  /** Called immediately after the git child is spawned. */
  onSpawn?: (pid: number) => void;
}
