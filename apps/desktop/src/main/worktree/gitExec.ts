/**
 * worktree-parallel-sessions: git CLI 包装。
 *
 * 职责:
 *   - 用 child_process.execFile 调用 git, 保留 stderr/stdout/exitCode
 *   - 自动处理 dubious-ownership: 若 stderr 含 "dubious ownership", 提取路径,
 *     `git config --global --add safe.directory <path>`, 重试**一次**原命令
 *   - 抛出 GitExecError 让上层 errorClassifier 解析为 WorktreeError
 *
 * 不在这里做 errorClassifier — 那是上层 createWorktree/removeWorktree 的职责,
 * 这里只把 raw stderr/code/cause 暴露出去。
 */

import { execFile, type ExecFileOptions } from 'node:child_process';

import { killProcessTree } from '../scheduler-host/proc-util';

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

  constructor(opts: {
    args: readonly string[];
    exitCode: number | null;
    stderr: string;
    stdout: string;
    cause?: NodeJS.ErrnoException;
  }) {
    super(
      `git ${opts.args.join(' ')} failed${
        opts.exitCode === null ? ' (spawn error)' : ` with exit code ${opts.exitCode}`
      }: ${opts.stderr.trim() || opts.cause?.message || '<no stderr>'}`,
    );
    this.name = 'GitExecError';
    this.args = opts.args;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdout = opts.stdout;
    this.cause = opts.cause;
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
   * (git 收 TERM 会清理 .lock), 等直接 git 进程退出后才收口, 宽限期内未退出的
   * 由整组 SIGKILL 兜底后再收口。两个平台都保证收口时进程树已终止——调用方拿到
   * 超时错误后立刻发起的下一个 git 操作不会与残留进程争抢同一仓库的 .lock。
   * 省略 = 不超时。
   */
  timeoutMs?: number;
}

/** POSIX 超时后 SIGTERM → SIGKILL 的宽限期:给 git 留出清理 .lock 的时间窗。 */
const POSIX_KILL_GRACE_MS = 1_500;

/**
 * 执行一次 git, 不做 dubious-ownership 自动重试(底层用)。
 */
function execFileOnce(
  args: readonly string[],
  cwd?: string,
  opts?: GitExecOpts,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    // 超时不走 execFile 内建 timeout:它只终止直接子进程,且回调要等 stdout/stderr
    // 流关闭——被后代进程继承并占住时回调可能远超 deadline 才来。这里自管定时器,
    // 超时先终止整棵进程树/进程组(两个平台都含后代),再显式收口 Promise。
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    // ExecFileOptions 类型没收录 detached,但 execFile 运行时把 options 原样传给
    // spawn,detached 照常生效——用交叉类型补上缺口。
    const spawnOptions: ExecFileOptions & { detached: boolean } = {
      cwd,
      // 防止超大输出炸内存。listBranches/listFiles 这类正常情况远低于此。
      maxBuffer: 16 * 1024 * 1024,
      env: opts?.extraEnv ? { ...process.env, ...opts.extraEnv } : undefined,
      // POSIX 让 git 自成进程组长:超时收口可对**整组**发信号,连
      // git-remote-http/credential helper 后代一起;Windows 的 detached 语义是
      // 脱离控制台,树杀走 taskkill /T,不需要也不该开。
      detached: process.platform !== 'win32',
      // Windows 下 git 走 cmd shell, 不需要 shell:true(也安全, 用 args 数组传参不走 shell 解析)
    };
    const child = execFile(
      'git',
      [...args],
      spawnOptions,
      (err, stdout, stderr) => {
        // execFile 默认 encoding 是 'utf8' → stdout/stderr 是 string;
        // 但若上层未来传了 encoding:'buffer', 兜底转字符串避免崩溃。
        const stdoutAny = stdout as unknown;
        const stderrAny = stderr as unknown;
        const stdoutStr =
          typeof stdoutAny === 'string'
            ? stdoutAny
            : Buffer.isBuffer(stdoutAny)
              ? stdoutAny.toString('utf8')
              : '';
        const stderrStr =
          typeof stderrAny === 'string'
            ? stderrAny
            : Buffer.isBuffer(stderrAny)
              ? stderrAny.toString('utf8')
              : '';
        if (err) {
          const errno = err as NodeJS.ErrnoException;
          // execFile 在子进程退出非 0 时也会 reject —— 此时 err.code 是 number(exit code)
          // 而非 string('ENOENT'/'EACCES')。区分开:
          //   - errno.code === 'ENOENT' / 'EACCES' / etc → spawn 阶段失败, exitCode = null
          //   - typeof (err as any).code === 'number' → 子进程退出码
          const numericCode = (err as unknown as { code?: unknown }).code;
          const exitCode =
            typeof numericCode === 'number' ? numericCode : null;
          settle(() =>
            reject(
              new GitExecError({
                args,
                exitCode,
                stderr: stderrStr,
                stdout: stdoutStr,
                cause: errno,
              }),
            ),
          );
          return;
        }
        settle(() => resolve({ stdout: stdoutStr, stderr: stderrStr }));
      },
    );

    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        const failTimeout = () =>
          settle(() =>
            reject(
              new GitExecError({
                args,
                exitCode: null,
                stderr: `timed out after ${timeoutMs}ms; process tree terminated`,
                stdout: '',
              }),
            ),
          );
        if (process.platform === 'win32') {
          // 复用 proc-util killProcessTree:taskkill /pid <pid> /T /F 整树终止,
          // 带重试与后代兜底枚举;树杀流程收尾后再收口,保证后续 worktree git
          // 操作不会与残留后代并发。
          killProcessTree(child.pid, child, () => failTimeout());
          return;
        }
        // POSIX:git 以 detached 自成进程组长——deadline 处对整组 SIGTERM,
        // git-remote-http/credential helper 后代一并收到,git 收 TERM 会清理
        // .lock。**不立即收口**:先等直接 git 进程真正退出(它才是持有仓库锁、
        // 更新 ref 的主体)再 failTimeout,否则调用方立刻发起的 rev-parse/
        // createWorktree 会与尚未退净的 fetch 并发抢锁;宽限期内仍未退出则整组
        // SIGKILL(killProcessTree)兜底后收口。等待有界(≤ POSIX_KILL_GRACE_MS),
        // freshBase 的网络预算按绝对 deadline 扣减,不会因此重开预算。
        if (child.exitCode !== null || child.signalCode !== null) {
          // 进程已经退出(典型:回调只是被后代占住的 stdio 拖住了)→ 直接收口
          failTimeout();
          return;
        }
        if (child.pid != null) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {
              /* 进程可能已退出 */
            }
          }
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            /* 进程可能已退出 */
          }
        }
        const onExit = () => {
          if (reaper !== undefined) clearTimeout(reaper);
          failTimeout();
        };
        const reaper: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          child.removeListener('exit', onExit);
          if (child.exitCode === null && child.signalCode === null) {
            // 忽略 SIGTERM 的顽固存活者:整组 SIGKILL(内核级立即生效),收尾
            // 回调里再收口——保证收口时进程树已终止,不留孤儿。
            killProcessTree(child.pid, child, () => failTimeout());
          } else {
            failTimeout();
          }
        }, POSIX_KILL_GRACE_MS);
        reaper.unref?.();
        child.once('exit', onExit);
      }, timeoutMs);
    }
  });
}

/**
 * 从 dubious-ownership stderr 中提取路径。git 的标准提示形如:
 *   fatal: detected dubious ownership in repository at 'C:/path/to/repo'
 * 或:
 *   fatal: detected dubious ownership in repository at C:/path/to/repo
 */
function extractDubiousPath(stderr: string): string | null {
  // 优先匹配带引号的形态(各平台/版本通用)
  const quoted = stderr.match(/dubious ownership in repository at ['"]([^'"]+)['"]/i);
  if (quoted) return quoted[1];
  // 兜底: 不带引号(老 git 版本)
  const bare = stderr.match(/dubious ownership in repository at\s+(\S+)/i);
  if (bare) return bare[1];
  return null;
}

/**
 * 主 API: 执行 git 命令, 自动处理 dubious-ownership。
 *
 * 行为:
 *   - 第一次 execFile 成功 → 直接 resolve
 *   - 失败 + stderr 含 "dubious ownership" → 提取 path, 配 safe.directory, 重试**一次**
 *   - 重试仍失败 → 抛 GitExecError(stderr 仍是 dubious-ownership, 让 classifier 走兜底)
 *   - 任何其他失败 → 抛 GitExecError 不重试
 */
export async function gitExec(
  args: readonly string[],
  cwd?: string,
  opts?: GitExecOpts,
): Promise<GitExecResult> {
  try {
    return await execFileOnce(args, cwd, opts);
  } catch (err) {
    if (!(err instanceof GitExecError)) throw err;
    // spawn ENOENT(git 未安装) 也走 GitExecError, 这里不该重试
    if (err.cause?.code === 'ENOENT') throw err;

    if (/dubious ownership/i.test(err.stderr)) {
      const dubiousPath = extractDubiousPath(err.stderr) ?? cwd;
      if (dubiousPath) {
        try {
          await execFileOnce(
            ['config', '--global', '--add', 'safe.directory', dubiousPath],
          );
          // 配完 safe.directory 后重试原命令
          return await execFileOnce(args, cwd, opts);
        } catch {
          // 重试或配置失败都直接抛原始错误(让 classifier 报 dubious-ownership)
          throw err;
        }
      }
    }
    throw err;
  }
}
