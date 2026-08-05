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

import { execFile } from 'node:child_process';

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
}

/**
 * 执行一次 git, 不做 dubious-ownership 自动重试(底层用)。
 */
function execFileOnce(
  args: readonly string[],
  cwd?: string,
  opts?: GitExecOpts,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        // 防止超大输出炸内存。listBranches/listFiles 这类正常情况远低于此。
        maxBuffer: 16 * 1024 * 1024,
        env: opts?.extraEnv ? { ...process.env, ...opts.extraEnv } : undefined,
        // Windows 下 git 走 cmd shell, 不需要 shell:true(也安全, 用 args 数组传参不走 shell 解析)
      },
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
          reject(
            new GitExecError({
              args,
              exitCode,
              stderr: stderrStr,
              stdout: stdoutStr,
              cause: errno,
            }),
          );
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr });
      },
    );
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
