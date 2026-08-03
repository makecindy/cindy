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
function queryWin32ProcessTable(
  timeoutMs: number = WIN32_PS_QUERY_TIMEOUT_MS,
): Promise<Win32ProcRow[] | null> {
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
        { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
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
        const failTimeout = (treeConfirmedGone: boolean) =>
          settle(() =>
            reject(
              new GitExecError({
                args,
                exitCode: null,
                stderr: treeConfirmedGone
                  ? `timed out after ${timeoutMs}ms; process tree terminated`
                  : `timed out after ${timeoutMs}ms; process tree cleanup unconfirmed`,
                stdout: '',
              }),
            ),
          );
        // 收尾总看门狗:在**任何树杀动作之前**武装——taskkill/进程表枚举自身
        // 卡死也保证 Promise 在 timeoutMs + KILL_CLEANUP_BUDGET_MS 内返回。到点
        // 仍未确认清空的,以「cleanup unconfirmed」这一可区分错误收口,不冒充
        // 正常终止;确认路径(快照轮询/组探测)成功时会提前 settle 并清掉本
        // 看门狗。调用方(freshBase)已把这份清理预算从共享网络 deadline 中
        // 预留,总墙钟不超预算。
        finishWatchdog = setTimeout(() => failTimeout(false), KILL_CLEANUP_BUDGET_MS);
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
                if (stdioReleased) failTimeout(false);
                else onStdioReleased = () => failTimeout(false);
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
              if (stdioReleased) failTimeout(true);
              else onStdioReleased = () => failTimeout(true);
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
          failTimeout(true);
          return;
        }
        groupPoll = setInterval(() => {
          if (groupEmpty()) failTimeout(true);
        }, POSIX_GROUP_POLL_INTERVAL_MS);
        groupPoll.unref?.();
        reaper = setTimeout(() => {
          // 忽略 SIGTERM 的顽固存活者:整组 SIGKILL。注意信号发送成功 ≠ 进程组
          // 已消失——将死进程在被内核回收前仍可能短暂持有 Git 锁。硬杀后组是否
          // 清空仍由 groupPoll 持续探测,清空按 terminated 收口;极端不可杀
          // (如 D 状态)由入口处武装的总看门狗按 cleanup unconfirmed 收口。
          killProcessTree(child.pid, child, () => {
            if (groupEmpty()) failTimeout(true);
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
