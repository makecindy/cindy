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
   * (git 收 TERM 会清理 .lock), 等**进程组清空**后才收口(直接 git 进程退出 ≠
   * 组清空, 幸存的 git-remote-http 或 credential helper 后代仍可能持锁), 宽限期
   * 内未清空的
   * 由整组 SIGKILL 兜底后再收口。两个平台都保证收口时进程树已终止——调用方拿到
   * 超时错误后立刻发起的下一个 git 操作不会与残留进程争抢同一仓库的 .lock。
   * 省略 = 不超时。
   */
  timeoutMs?: number;
}

/** POSIX 超时后 SIGTERM → SIGKILL 的宽限期:给 git 留出清理 .lock 的时间窗。 */
const POSIX_KILL_GRACE_MS = 1_500;
/** POSIX 宽限期内探测进程组是否清空的轮询间隔。 */
const POSIX_GROUP_POLL_INTERVAL_MS = 100;
/**
 * 硬杀完成后等待后代真正退净的有界看门狗。**不是**「后代已清空」的证明——正常
 * 收口依赖组探测(POSIX)或进程表快照确认(Windows),看门狗只防极端不可杀进程
 * 把 Promise 永远挂死。
 */
const DESCENDANT_SETTLE_WAIT_MS = 1_500;
/** Windows 进程表查询(PowerShell Get-CimInstance)自身的超时。 */
const WIN32_PS_QUERY_TIMEOUT_MS = 3_000;
/** Windows 确认快照后代退净的轮询间隔。 */
const WIN32_DESCENDANT_POLL_INTERVAL_MS = 250;

interface Win32ProcRow {
  pid: number;
  ppid: number;
  created: string;
}

/**
 * Windows:一次性拉当前进程表(pid/ppid/创建时间),**仅观察**,用于确认超时后
 * git 的后代已全部退出——绝不据此杀进程,pid 被复用最多让确认多等一会(直到
 * 看门狗),不存在误杀风险;pid+CreationDate 双键匹配基本免疫复用误判。
 * PowerShell 缺失/超时/输出异常一律返回 null(调用方降级)。
 */
function queryWin32ProcessTable(): Promise<Win32ProcRow[] | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Win32ProcRow[] | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: WIN32_PS_QUERY_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) {
            finish(null);
            return;
          }
          try {
            const raw: unknown = JSON.parse(String(stdout));
            const rows = Array.isArray(raw) ? raw : [raw];
            finish(
              rows
                .map((r) => {
                  const row = r as { ProcessId?: unknown; ParentProcessId?: unknown; CreationDate?: unknown };
                  return {
                    pid: Number(row.ProcessId),
                    ppid: Number(row.ParentProcessId),
                    created: String(row.CreationDate ?? ''),
                  };
                })
                .filter((r) => Number.isFinite(r.pid)),
            );
          } catch {
            finish(null);
          }
        },
      );
    } catch {
      finish(null);
    }
  });
}

/** 从进程表收集 rootPid 自身(若仍在)与全部多级后代,作为待确认退净的幸存者集合。 */
function collectWin32TreeSurvivors(
  table: Win32ProcRow[],
  rootPid: number,
): Array<{ pid: number; created: string }> {
  const childrenByPpid = new Map<number, Win32ProcRow[]>();
  for (const row of table) {
    const list = childrenByPpid.get(row.ppid);
    if (list) list.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  const out: Array<{ pid: number; created: string }> = [];
  const rootRow = table.find((r) => r.pid === rootPid);
  if (rootRow) out.push({ pid: rootPid, created: rootRow.created });
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const row of childrenByPpid.get(cur) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      out.push({ pid: row.pid, created: row.created });
      queue.push(row.pid);
    }
  }
  return out;
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
    // 超时不走 execFile 内建 timeout:它只终止直接子进程,且回调要等 stdout/stderr
    // 流关闭——被后代进程继承并占住时回调可能远超 deadline 才来。这里自管定时器,
    // 超时先终止整棵进程树/进程组(两个平台都含后代),再显式收口 Promise。
    let settled = false;
    // 超时收口流程一旦启动就接管最终 settle:execFile 回调只代表 stdio 流关闭,
    // 不代表进程组已清空——此后回调不得再 settle,否则会在 credential helper 等
    // 后代还活着时提前结束 Promise,调用方随即发起的 git 操作与残留进程争锁。
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reaper: ReturnType<typeof setTimeout> | undefined;
    let groupPoll: ReturnType<typeof setInterval> | undefined;
    let finishWatchdog: ReturnType<typeof setTimeout> | undefined;
    // Windows 收尾用:execFile 回调已到 = 全部继承 stdio 的进程都已退出/放手。
    let stdioReleased = false;
    let onStdioReleased: (() => void) | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (reaper !== undefined) clearTimeout(reaper);
      if (groupPoll !== undefined) clearInterval(groupPoll);
      if (finishWatchdog !== undefined) clearTimeout(finishWatchdog);
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
        if (timedOut) {
          // 超时路径已接管:最终 reject 只在进程树确认退净后发生,这里直接丢弃
          // 迟到结果(操作已按超时定性),绝不提前 settle。此刻回调的意义只剩一个
          // 信号:stdio 流已关闭 = 全部继承句柄的后代都已退出/放手——通知
          // Windows 收尾流程可以收口了。
          stdioReleased = true;
          onStdioReleased?.();
          return;
        }
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
        timedOut = true;
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
          // 终止走 proc-util killProcessTree(taskkill /T /F,带重试与后代兜底;
          // git.exe 已退出时它按 pid 复用防线就地收束,不按 ppid 枚举杀,防误杀)。
          // **确认**独立于终止:并行拉一次进程表快照,收集 git 树的幸存者
          // (pid+创建时间双键,仅观察不杀),树杀收尾后轮询确认幸存者全部消失
          // 才收口——覆盖「git.exe 已退、credential helper 等后代仍活」的窗口。
          // 进程表不可用(PowerShell 缺失/超时)降级为 stdio 放手信号(execFile
          // 回调 = 继承句柄全部释放);两条路都有看门狗防永悬(见常量注释,
          // 看门狗不构成清空证明)。
          const snapshotPromise = child.pid != null ? queryWin32ProcessTable() : Promise.resolve(null);
          killProcessTree(child.pid, child, () => {
            void snapshotPromise.then((table) => {
              if (settled) return;
              const survivors =
                table !== null && child.pid != null ? collectWin32TreeSurvivors(table, child.pid) : null;
              if (survivors !== null && survivors.length === 0) {
                failTimeout();
                return;
              }
              if (survivors !== null) {
                const keys = survivors.map((s) => `${s.pid}:${s.created}`);
                groupPoll = setInterval(() => {
                  void queryWin32ProcessTable().then((t) => {
                    if (settled || t === null) return;
                    const present = new Set(t.map((r) => `${r.pid}:${r.created}`));
                    if (!keys.some((k) => present.has(k))) failTimeout();
                  });
                }, WIN32_DESCENDANT_POLL_INTERVAL_MS);
                groupPoll.unref?.();
              } else if (stdioReleased) {
                failTimeout();
                return;
              } else {
                onStdioReleased = () => failTimeout();
              }
              finishWatchdog = setTimeout(() => failTimeout(), DESCENDANT_SETTLE_WAIT_MS);
              finishWatchdog.unref?.();
            });
          });
          return;
        }
        // POSIX:git 以 detached 自成进程组长——deadline 处对整组 SIGTERM,
        // git-remote-http/credential helper 后代一并收到,git 收 TERM 会清理
        // .lock。**收口判定按进程组是否清空**(kill(-pid, 0) 探测),不按直接
        // git 进程的 exit:直接进程退出 ≠ 组已清空,组里幸存的 git-remote-* 或
        // credential helper 仍可能持有仓库锁或继续更新 ref,提前收口会让调用方
        // 立刻发起的 rev-parse/createWorktree 与之并发。组未清空时短间隔轮询
        // 等待;宽限期到点仍有存活者则整组 SIGKILL(killProcessTree),在其收尾
        // 回调里收口——保证收口时组内进程必已终止,不留孤儿。等待有界
        // (≤ POSIX_KILL_GRACE_MS),freshBase 的网络预算按绝对 deadline 扣减,
        // 不会因此重开预算。
        const groupEmpty = (): boolean => {
          if (child.pid == null) return true;
          try {
            process.kill(-child.pid, 0);
            return false;
          } catch {
            return true;
          }
        };
        if (!groupEmpty()) {
          try {
            process.kill(-child.pid!, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {
              /* 进程可能刚好退出 */
            }
          }
        }
        if (groupEmpty()) {
          // 组已清空(直接进程与全部后代都已退出,回调只是被继承的 stdio 拖住)
          failTimeout();
          return;
        }
        groupPoll = setInterval(() => {
          if (groupEmpty()) failTimeout();
        }, POSIX_GROUP_POLL_INTERVAL_MS);
        groupPoll.unref?.();
        reaper = setTimeout(() => {
          // 忽略 SIGTERM 的顽固存活者:整组 SIGKILL。注意信号发送成功 ≠ 进程组
          // 已消失——将死进程在被内核回收前仍可能短暂持有 Git 锁。硬杀收尾后
          // 组已空才收口;未空则继续由 groupPoll 轮询确认清空,极端不可杀
          // (如 D 状态)由有界看门狗收口,不让 Promise 永悬。
          killProcessTree(child.pid, child, () => {
            if (groupEmpty()) {
              failTimeout();
              return;
            }
            finishWatchdog = setTimeout(() => failTimeout(), DESCENDANT_SETTLE_WAIT_MS);
            finishWatchdog.unref?.();
          });
        }, POSIX_KILL_GRACE_MS);
        reaper.unref?.();
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
