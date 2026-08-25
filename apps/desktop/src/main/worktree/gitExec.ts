/**
 * worktree-parallel-sessions: git CLI 包装。
 *
 * 职责:
 *   - 用 child_process.execFile 调用 git, 保留 stderr/stdout/exitCode
 *   - 自动处理 dubious-ownership: 若 stderr 含 "dubious ownership", 提取路径,
 *     幂等地 `git config --global --add safe.directory <path>`(已存在则不重复添加),
 *     重试**一次**原命令
 *   - 抛出 GitExecError 让上层 errorClassifier 解析为 WorktreeError
 *
 * 不在这里做 errorClassifier — 那是上层 createWorktree/removeWorktree 的职责,
 * 这里只把 raw stderr/code/cause 暴露出去。
 */

import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { killProcessTree } from '../scheduler-host/proc-util';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createLogger } from '../logger';
import {
  beginExecFileDiagnostic,
  execFileWithDiagnostics,
} from '../utils/execFileDiagnostics';

const log = createLogger('gitExec');

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
 * 超时后整套清理(SIGTERM/宽限/SIGKILL/退净确认)的总预算,也是超时路径下
 * Promise 相对 timeoutMs 的最大额外墙钟。看门狗在任何树杀动作之前武装,到点
 * 仍未确认清空按「cleanup unconfirmed」收口——它**不是**清空证明,只保证有界
 * 返回;正常收口依赖组探测(POSIX)或进程表快照轮询(Windows)。调用方若受
 * 共享 deadline 约束,应把这份预算从每步网络超时里预留(见 freshBase)。
 */
export const KILL_CLEANUP_BUDGET_MS = 3_000;
/** Windows 进程表查询(PowerShell Get-CimInstance)自身的超时。 */
const WIN32_PS_QUERY_TIMEOUT_MS = 3_000;
/**
 * 杀前血缘快照的独立短预算:必须显著小于 KILL_CLEANUP_BUDGET_MS——快照与总
 * 看门狗同预算时,快照挂满会让 killProcessTree 在看门狗收口前根本来不及启动,
 * 卡住的 git 进程原样存活。
 */
const WIN32_SNAPSHOT_TIMEOUT_MS = 1_000;
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
async function queryWin32ProcessTable(
  timeoutMs: number = WIN32_PS_QUERY_TIMEOUT_MS,
): Promise<Win32ProcRow[] | null> {
  try {
    const { stdout } = await execFileWithDiagnostics({
      source: 'worktree.git.process-table',
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
      ],
      options: { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      failureLevel: 'info',
    });
    const raw: unknown = JSON.parse(stdout);
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows
      .map((r) => {
        const row = r as {
          ProcessId?: unknown;
          ParentProcessId?: unknown;
          CreationDate?: unknown;
        };
        return {
          pid: Number(row.ProcessId),
          ppid: Number(row.ParentProcessId),
          created: String(row.CreationDate ?? ''),
        };
      })
      .filter((r) => Number.isFinite(r.pid));
  } catch {
    return null;
  }
}

/**
 * 执行一次 git, 不做 dubious-ownership 自动重试(底层用)。
 */
function execFileOnce(
  args: readonly string[],
  cwd?: string,
  opts?: GitExecOpts,
): Promise<GitExecResult> {
  const diagnostic = beginExecFileDiagnostic('worktree.git');
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
    const rejectWithGitError = (error: GitExecError) =>
      settle(() => {
        if (error.exitCode === null) diagnostic.fail(error.cause ?? error);
        else diagnostic.succeed();
        reject(error);
      });
    const resolveWithResult = (result: GitExecResult) =>
      settle(() => {
        diagnostic.succeed();
        resolve(result);
      });

    let child: ChildProcess;
    try {
      child = execFile(
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
            const exitCode = typeof numericCode === 'number' ? numericCode : null;
            rejectWithGitError(
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
          resolveWithResult({ stdout: stdoutStr, stderr: stderrStr });
        },
      );
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      rejectWithGitError(
        new GitExecError({
          args,
          exitCode: null,
          stderr: '',
          stdout: '',
          cause: cause as NodeJS.ErrnoException,
        }),
      );
      return;
    }

    const handleChildProcessError = (error: unknown) => {
      if (timedOut || settled) return;
      const cause = error instanceof Error ? error : new Error(String(error));
      const failure = new GitExecError({
        args,
        exitCode: null,
        stderr: '',
        stdout: '',
        cause: cause as NodeJS.ErrnoException,
      });
      startTreeCleanup(() => failure);
    };
    child.once('error', handleChildProcessError);
    child.stdout?.once('error', handleChildProcessError);
    child.stderr?.once('error', handleChildProcessError);

    function startTreeCleanup(
      createFailure: (treeConfirmedGone: boolean) => GitExecError,
    ): void {
      if (timedOut || settled) return;
      timedOut = true;
      const finishCleanup = (treeConfirmedGone: boolean) =>
        rejectWithGitError(createFailure(treeConfirmedGone));
      // 收尾总看门狗:在**任何树杀动作之前**武装——taskkill/进程表枚举自身
      // 卡死也保证 Promise 在 KILL_CLEANUP_BUDGET_MS 内返回。到点仍未确认
      // 清空时按调用方提供的「未确认」失败收口；清理动作仍继续执行。
      finishWatchdog = setTimeout(() => finishCleanup(false), KILL_CLEANUP_BUDGET_MS);
      finishWatchdog.unref?.();
      if (process.platform === 'win32') {
        // 终止走 proc-util killProcessTree(taskkill /T /F,带重试与后代兜底;
        // git.exe 已退出时它按 pid 复用防线就地收束,不按 ppid 枚举杀,防误杀)。
        // **确认**独立于终止:并行拉一次进程表快照,收集 git 树的幸存者
        // (pid+创建时间双键,仅观察不杀),树杀收尾后轮询确认幸存者全部消失
        // 才按「terminated」收口——覆盖「git.exe 已退、credential helper 等
        // 后代仍活」的窗口。进程表不可用(PowerShell 缺失/超时)属「无法持续
        // 确认」:等 stdio 放手信号后仍按 cleanup unconfirmed 收口,不冒充确认。
        // 顺序:**先**拍血缘快照(树还活着,中间父进程可被捕获),**再**启动
        // 树杀——两者并行时先被杀掉的中间父会从表中消失,其后代的 ppid 链断裂
        // 导致漏追踪。快照之后仍有一个不可观测窗口:中间父在超时前就已自然
        // 退出的孤儿后代无法靠血缘识别(纯 Node 造不出 Job Object,引原生依赖
        // 远超本 PR 范围)——用继承 stdio 作补充信号封堵:execFile 回调未到 =
        // 仍有进程持有继承句柄,即便血缘集已清空也不判 terminated。
        // 「血缘集清空 + stdio 放手」两个信号都满足才算树退净;进程表不可用
        // (无 PowerShell/查询超时)只剩单一信号,按 cleanup unconfirmed 收口。
        void (async () => {
          const rootPid = child.pid;
          // 快照用独立短预算(WIN32_SNAPSHOT_TIMEOUT_MS):保证即便快照挂满,
          // killProcessTree 也在总看门狗到期前启动。快照返回后**不检查
          // settled 直接进树杀**——清理义务独立于 Promise 状态,即使看门狗已
          // 按 unconfirmed 收口,树杀也必须执行,否则卡住的 fetch 原样存活。
          const preKillTable =
            rootPid != null ? await queryWin32ProcessTable(WIN32_SNAPSHOT_TIMEOUT_MS) : null;
          if (preKillTable === null || rootPid == null) {
            killProcessTree(child.pid, child, () => {
              if (settled) return;
              if (stdioReleased) finishCleanup(false);
              else onStdioReleased = () => finishCleanup(false);
            });
            return;
          }
          // 追踪 git 树的**派生闭包**,不是固定的初始快照:每轮把 ppid 命中
          // 已知树成员的新进程并入(覆盖 credential helper 在两轮轮询之间
          // fork 出的后代;pid+创建时间双键,仅观察不杀——ppid 撞上被复用的
          // pid 只会让确认多等一会,由入口看门狗兜底,无误杀风险)。
          const trackedKeys = new Set<string>();
          const knownPids = new Set<number>([rootPid]);
          const absorb = (t: Win32ProcRow[]) => {
            const rootRow = t.find((r) => r.pid === rootPid);
            if (rootRow) trackedKeys.add(`${rootRow.pid}:${rootRow.created}`);
            // 闭包迭代:同一张表里可能有「新成员 → 其子进程」的链
            let grew = true;
            while (grew) {
              grew = false;
              for (const row of t) {
                const key = `${row.pid}:${row.created}`;
                if (knownPids.has(row.ppid) && !trackedKeys.has(key)) {
                  trackedKeys.add(key);
                  knownPids.add(row.pid);
                  grew = true;
                }
              }
            }
          };
          const treePresent = (t: Win32ProcRow[]): boolean => {
            const present = new Set(t.map((r) => `${r.pid}:${r.created}`));
            for (const key of trackedKeys) if (present.has(key)) return true;
            return false;
          };
          absorb(preKillTable);
          const settleWhenStdioAlsoReleased = () => {
            // 血缘集已清空;还要等 stdio 放手才判 terminated——封堵「中间父在
            // 快照前已亡,其孤儿(血缘不可见)仍持继承句柄」的窗口。不放手由
            // 入口看门狗按 cleanup unconfirmed 收口。
            if (stdioReleased) finishCleanup(true);
            else onStdioReleased = () => finishCleanup(true);
          };
          killProcessTree(child.pid, child, () => {
            if (settled) return;
            // 串行轮询:上一轮查询完成后才调度下一轮——单次查询可耗到自身
            // 超时(3s),WMI 卡顿时 setInterval 会持续叠加 PowerShell 进程。
            // 收口(settle)清掉重调度定时器;在途查询由其自身超时结束。
            const pollOnce = () => {
              void queryWin32ProcessTable().then((t) => {
                if (settled) return;
                if (t !== null) {
                  absorb(t);
                  if (!treePresent(t)) {
                    settleWhenStdioAlsoReleased();
                    return;
                  }
                }
                groupPoll = setTimeout(pollOnce, WIN32_DESCENDANT_POLL_INTERVAL_MS);
                groupPoll.unref?.();
              });
            };
            pollOnce();
          });
        })();
        return;
      }
      // POSIX:git 以 detached 自成进程组长——对整组 SIGTERM,等待清空;
      // 宽限期到点仍有存活者则整组 SIGKILL。超时与管道异常共用本路径。
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
        finishCleanup(true);
        return;
      }
      groupPoll = setInterval(() => {
        if (groupEmpty()) finishCleanup(true);
      }, POSIX_GROUP_POLL_INTERVAL_MS);
      groupPoll.unref?.();
      reaper = setTimeout(() => {
        killProcessTree(child.pid, child, () => {
          if (groupEmpty()) finishCleanup(true);
        });
      }, POSIX_KILL_GRACE_MS);
      reaper.unref?.();
    }

    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        startTreeCleanup((treeConfirmedGone) =>
          new GitExecError({
            args,
            exitCode: null,
            stderr: treeConfirmedGone
              ? `timed out after ${timeoutMs}ms; process tree terminated`
              : `timed out after ${timeoutMs}ms; process tree cleanup unconfirmed`,
            stdout: '',
          }),
        );
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
 * safe.directory 全局配置「读改写」的跨进程锁文件路径。
 *
 * 读(get-all)与写(add)是两条独立的 git config 命令,本身不互斥:两个 Cindy 实例
 * 并发触发同一仓库的 dubious-ownership 时可能都读到「不存在」再各加一条,堆积出
 * 重复条目(#2627)。用跨进程锁把这两步圈成原子区。锁文件用 os.tmpdir() 落地;
 * Linux 的 /tmp 多用户共享,用 uid(Windows 无 uid 时退回 0)区分用户,避免不同用户
 * 串扰同一把锁。
 */
export function globalSafeDirectoryLockPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cindy-git-safe-directory-${uid}.lock`);
}

/**
 * 把一条路径规范成 git 呈现/比较 safe.directory 时用的拼写。
 *
 * Windows 上 git 在错误信息里以 `C:/...`(正斜杠)输出路径, 而 `path.join` 产出的是
 * 原生 `C:\...`。`git config --fixed-value` 是字符串精确相等, 若 add 写正斜杠、清理
 * 用反斜杠, 会永远匹配不到并残留条目。所以 add 与清理都必须经过同一个规范化函数。
 */
export function normalizeSafeDirectorySpelling(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/**
 * 给定一个逻辑路径, 返回需要精确清理的 safe.directory 拼写集合。覆盖两类来源:
 *   - 规范化拼写(C:/...): gitExec 从 dubious-ownership 报错提取并 add 的拼写;
 *   - 原生拼写(C:\...): 历史版本无条件 add、或 gitExec 用 cwd 兜底时写下的拼写。
 * 两边都删, 才能把历史遗留的反斜杠条目一并清掉。
 */
export function safeDirectorySpellings(p: string): string[] {
  const normalized = normalizeSafeDirectorySpelling(p);
  return normalized === p ? [p] : [normalized, p];
}

/**
 * 读取当前全局 safe.directory 的值列表。仅当「键不存在」(git config --get-all 对
 * 缺失键返回退出码 1)时按空列表处理;其余读取错误(配置锁冲突/权限/配置损坏/spawn
 * 失败)必须向上抛,否则会把「读不到」误判成「未配置」而重复 --add,反而制造出
 * 本条修复要避免的重复条目。
 */
async function readGlobalSafeDirectories(): Promise<string[]> {
  try {
    const { stdout } = await execFileOnce(['config', '--global', '--get-all', 'safe.directory']);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch (err) {
    if (err instanceof GitExecError && err.exitCode === 1) return [];
    throw err;
  }
}

/**
 * 幂等地把 targetPath 加入全局 safe.directory: 已存在则不再 --add, 避免同一路径
 * 因多个 git 操作反复触发 dubious-ownership 而用 --add 堆积出重复记录(#2627)。
 *
 * 读+写放在 withCrossProcessLock 里保证跨进程原子。**未持锁绝不无锁读改写**:其它
 * 实例长期持锁 / 锁基础设施不可用时 fail-closed 抛错,让 gitExec 把原始
 * dubious-ownership 错误还给调用方,而不是退化成并发写入重复条目。用底层
 * execFileOnce 而非 gitExec, 防止递归进入 dubious-ownership 分支。
 */
async function ensureGlobalSafeDirectory(targetPath: string): Promise<void> {
  await withCrossProcessLock(
    globalSafeDirectoryLockPath(),
    { label: 'git-safe-directory', waitMs: 1_000 },
    async (status) => {
      if (!status.held) {
        throw new Error('could not acquire the global safe.directory lock');
      }
      // 统一成 git 的拼写再读写: 让幂等检查与后续清理命中同一个值。
      const normalized = normalizeSafeDirectorySpelling(targetPath);
      if ((await readGlobalSafeDirectories()).some((p) => p === normalized)) return;
      await execFileOnce(['config', '--global', '--add', 'safe.directory', normalized]);
    },
  );
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
          await ensureGlobalSafeDirectory(dubiousPath);
          // 配完 safe.directory 后重试原命令
          return await execFileOnce(args, cwd, opts);
        } catch (cause) {
          // 对外错误契约不变: 调用方/classifier 仍拿到原始 dubious-ownership 错误。
          // 但 ensureGlobalSafeDirectory 的真实失败(--get-all 权限/锁冲突/配置损坏,
          // 或拿不到跨进程锁)不能被静默吞掉 —— 先落日志保住诊断信息, 再抛原始错误。
          log.warn(
            `gitExec auto safe.directory add failed for ${dubiousPath}:`,
            cause instanceof Error ? cause.message : String(cause),
          );
          throw err;
        }
      }
    }
    throw err;
  }
}
