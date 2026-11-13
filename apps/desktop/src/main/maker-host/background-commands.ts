/**
 * maker-host/background-commands.ts —— 会话的后台命令 + 完成回注。
 *
 * 动机:模型可调的 bash 是同步阻塞的(Cindy 默认 300s、封顶 1800s),长测试 /
 * 门禁 / `gh run watch` 只能干等或 sleep 轮询。本服务让会话把一条 shell 命令
 * 交给宿主在后台运行:立即返回 runId/日志路径,回合可以结束;进程退出时复用
 * scheduler 撞忙排队桥(enqueueSchedulerPrompt)把「宿主口吻的完成报告」注入
 * 原会话 —— 会话空闲即派发,正忙则进可见队列按序派发,没有轮询。
 *
 * 边界(v1 明确不做的):
 *  - 应用重启丢回注:注册表只在内存。进程本身不杀(POSIX detached / Windows
 *    无父子连带),日志保留在磁盘,重启后模型可凭 log_path 自行读取。
 *  - 不跨电脑:命令在会话所属的本机运行;远程会话由工具层直接拒绝。
 *  - 名额与治理分离：并发名额在命令 exit 时让出，已退出的命令不占名额（2026-11-13
 *    事故：win32 名额占到硬顶，秒死命令堵满全局 8 槽，所有会话 TOO_MANY_RUNS）；
 *    其后代（`&`/`start /b`）的治理照旧到硬顶——POSIX 上 detached 进程组到点随组
 *    被杀；Windows 上 shell 退出后宿主不再按 PID 查杀（仓库既有约定，防 PID 复用
 *    误杀），到点只日志留痕。工具描述已把「不要自行后台化」写成使用约束。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { readdir, stat, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';

import { killProcessTree } from '../scheduler-host/proc-util.js';
import {
  isShellDesktopInputCommand,
  SHELL_DESKTOP_INPUT_DENIAL_CODE,
  SHELL_DESKTOP_INPUT_DENIAL_REASON,
} from '@cindy/maker-core';
import type { SchedulerQueuedPromptRequest } from '../maker-ipc/register.js';

/** 后台命令的最长存活:防孤儿进程无限挂(默认与显式上限共用这条硬顶)。 */
export const BACKGROUND_COMMAND_MAX_MS = 24 * 60 * 60 * 1000;
/** 同一应用实例内并发后台命令上限;超出直接拒绝,逼模型先收敛。 */
export const BACKGROUND_COMMAND_MAX_CONCURRENT = 8;
/** 单条日志文件上限(保头部,超出丢弃并写截断标记);报告用内存尾部不受此限。 */
export const BACKGROUND_COMMAND_LOG_CAP_BYTES = 5 * 1024 * 1024;
/** 报告附带的内存日志尾部(保留最后的输出,不受文件截断影响)。 */
const TAIL_CAP_BYTES = 64 * 1024;
/** 完成报告注入撞上排队暂停/快照未恢复时的重试间隔与次数(与 runner 顺延同量级)。 */
const REPORT_RETRY_DELAY_MS = 60_000;
const REPORT_RETRY_MAX_DELAY_MS = 300_000;
/** 日志保留天数;过期文件在服务使用时清理(报告可能已消费,磁盘不应无限涨)。 */
const LOG_RETENTION_DAYS = 14;
/** exit 后读日志文件尾部的短延迟:容让杀毒/索引器对日志文件的瞬时锁。 */
const SETTLE_READ_DELAY_MS = 200;

export interface BackgroundCommandStartInput {
  sessionId: string;
  /** 调用时的会话实例;由工具层传入、宿主层用于拒绝过期实例,服务本身不消费。 */
  sessionInstanceId?: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export type BackgroundCommandStartResult =
  | { ok: true; runId: string; logPath: string; pid: number | undefined }
  | {
      ok: false;
      errorCode: 'INVALID_ARGS' | 'TOO_MANY_RUNS' | 'SPAWN_FAILED' | 'LOG_FAILED' | 'DISPOSED' | 'DESKTOP_INPUT_BLOCKED';
      message: string;
    };

export interface BackgroundCommandServiceDeps {
  /** scheduler 撞忙排队桥的导出薄封装;会话忙则排队、空闲即派发。 */
  enqueueReport: (
    req: SchedulerQueuedPromptRequest,
  ) => Promise<{ clientId: string } | { duplicate: true } | { retry: true }>;
  /** 日志目录按当前账号解析(owner 隔离);每次 start 时现取,账号切换后落到新目录。 */
  resolveLogDir: () => string;
  /** 报告 retry 首次间隔;仅测试注入,生产默认 60s 指数退避、封顶 5min。 */
  reportRetryDelayMs?: number;
  /** 报告 retry 间隔封顶;仅测试注入,与首间隔配套用。 */
  reportRetryMaxDelayMs?: number;
  logger: {
    info?(message: string, data?: unknown): void;
    warn?(message: string, data?: unknown): void;
  };
}

export function createBackgroundCommandService(deps: BackgroundCommandServiceDeps) {
  // active=false：命令已退出、并发名额已让出；条目保留是因为治理计时器（硬顶杀树 /
  // POSIX 组探测）仍在管进程树，树死透或硬顶到点才整体移除。
  const running = new Map<string, {
    startedAt: number;
    logPath: string;
    timeoutTimer: NodeJS.Timeout;
    groupPoll: NodeJS.Timeout | null;
    killTree: () => void;
    capPoll: NodeJS.Timeout;
    active: boolean;
  }>();
  const activeCommandCount = (): number => {
    let n = 0;
    for (const entry of running.values()) if (entry.active) n += 1;
    return n;
  };
  // 切账号时置位:在途报告(含 retry 循环)不再投递——旧账号会话的回注不能落进新账号。
  let disposed = false;
  // 孤儿日志巡检只随服务起一次(start 可能多次),dispose 收。
  let orphanPoll: NodeJS.Timeout | null = null;

  function pruneOldLogs(): void {
    const logDir = deps.resolveLogDir();
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    void readdir(logDir)
      .then((entries) => {
        for (const entry of entries) {
          if (!entry.startsWith('bg-') || !entry.endsWith('.log')) continue;
          const full = path.join(logDir, entry);
          stat(full)
            .then((info) => {
              if (info.mtimeMs < cutoff) return unlink(full);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  function truncateOrphanLogs(): void {
    // 孤儿日志兜底(体量上限的「重启后存活」):注册表只在内存,重启后上一版进程
    // 直写的输出没人限流。把不在册且超上限的日志截回上限——只缩日志、不杀进程
    // (与「重启不杀」同一口径);在册条目的体量由各自 capPoll 管。fd 是 O_APPEND,
    // 截断后写入落在新 EOF,文件再增长,下一轮再截——快写者的上界是
    // 「写入速率 × 巡检间隔」,不写穿磁盘。
    const logDir = deps.resolveLogDir();
    const owned = new Set<string>();
    for (const entry of running.values()) owned.add(entry.logPath);
    void readdir(logDir)
      .then((entries) => {
        for (const entry of entries) {
          if (!entry.startsWith('bg-') || !entry.endsWith('.log')) continue;
          const full = path.join(logDir, entry);
          if (owned.has(full)) continue;
          stat(full)
            .then((info) => {
              if (info.size > BACKGROUND_COMMAND_LOG_CAP_BYTES) {
                return truncate(full, BACKGROUND_COMMAND_LOG_CAP_BYTES);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  function buildReport(input: {
    command: string;
    logPath: string;
    logTruncated: boolean;
    durationMs: number;
    exit: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      spawnError?: string;
    };
    tail: string;
  }): { text: string; persistedContent: string } {
    const seconds = Math.max(0, Math.round(input.durationMs / 1000));
    const duration =
      seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
    const status = input.exit.spawnError
      ? `启动失败（${input.exit.spawnError}）`
      : input.exit.timedOut
        ? '超过时限被强制终止（结果未知；若命令有副作用请先核实）'
        : input.exit.code === 0
          ? '成功（exit 0）'
          : input.exit.code !== null
            ? `失败（exit ${input.exit.code}）`
            : `被信号终止（${input.exit.signal ?? 'unknown'}）`;
    const head = input.command.length > 160 ? `${input.command.slice(0, 160)}…` : input.command;
    const logLine = input.logTruncated
      ? `输出超过 ${BACKGROUND_COMMAND_LOG_CAP_BYTES} 字节上限，进程树已被终止。日志文件（终止前的记录）：${input.logPath}`
      : `完整日志：${input.logPath}`;
    const text =
      `〔后台命令完成〕这条消息由宿主在后台命令结束时自动发来，不是主人输入。\n` +
      `命令：${head}\n状态：${status}\n耗时：${duration}\n` +
      (input.tail.trim() ? `日志尾部：\n---\n${input.tail}\n---\n` : '') +
      `${logLine}\n` +
      `请根据结果继续推进任务；不需要主人决策时向主人简短汇报即可。`;
    return { text, persistedContent: `后台命令完成 · ${status} · ${head}` };
  }

  function deliverReport(params: {
    sessionId: string;
    runId: string;
    command: string;
    logPath: string;
    logTruncated: boolean;
    durationMs: number;
    exit: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      spawnError?: string;
    };
    tail: string;
  }): void {
    let attempts = 0;
    const attempt = async (): Promise<void> => {
      attempts += 1;
      const { text, persistedContent } = buildReport(params);
      if (disposed) {
        // 服务已被账号边界作废:报告丢弃,也不再排下一次 retry。
        deps.logger.warn?.('[background-command] report dropped: service disposed (account boundary)', {
          runId: params.runId,
        });
        return;
      }
      let result: Awaited<ReturnType<typeof deps.enqueueReport>>;
      try {
        result = await deps.enqueueReport({
          sessionId: params.sessionId,
          text,
          persistedContent,
          inheritTargetPlanMode: true,
          origin: {
            kind: 'scheduler',
            scheduleId: `bgcmd:${params.runId}`,
            scheduleName: '后台命令',
          },
          onAccepted: () => {},
        });
      } catch (error) {
        // 会话被删/归档时这里会抛;报告无处投递,记日志后放弃。
        deps.logger.warn?.('[background-command] report delivery failed', {
          runId: params.runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (result && 'retry' in result) {
        // retry 是等待型(队列未恢复/用户暂停,只有用户显式操作解除):不按次数
        // 放弃——旧上限 10 分钟会把暂停超时的完成报告永久丢掉。任务被删/归档
        // 时 enqueueReport 会 throw,走上方的放弃分支,这里不会空转。60s 起步
        // 指数退避、封顶 5min,避免长时间暂停时空转刷调用。
        const base = deps.reportRetryDelayMs ?? REPORT_RETRY_DELAY_MS;
        const cap = deps.reportRetryMaxDelayMs ?? REPORT_RETRY_MAX_DELAY_MS;
        const delay = Math.min(base * 2 ** (attempts - 1), cap);
        const timer = setTimeout(() => void attempt(), delay);
        timer.unref?.();
      }
    };
    void attempt();
  }

  return {
    start(input: BackgroundCommandStartInput): BackgroundCommandStartResult {
      if (disposed) {
        return {
          ok: false,
          errorCode: 'DISPOSED',
          message: 'service disposed (account boundary); a fresh service is created on next use',
        };
      }
      const command = input.command?.trim();
      if (!command || !input.sessionId || !input.cwd) {
        return {
          ok: false,
          errorCode: 'INVALID_ARGS',
          message: 'command, sessionId and cwd are required',
        };
      }
      // 桌面键鼠只走 cindy_computer：后台命令是独立执行入口（不经过 Bash 的 PreToolUse
      // 守卫），完全访问档也不会在这里再弹审批，必须在宿主入口复用同一份判定，
      // 否则 osascript keystroke / cliclick 可绕过键鼠保护（CU-014 同类事故）。
      if (isShellDesktopInputCommand(command)) {
        return {
          ok: false,
          errorCode: 'DESKTOP_INPUT_BLOCKED',
          message: `${SHELL_DESKTOP_INPUT_DENIAL_CODE}: ${SHELL_DESKTOP_INPUT_DENIAL_REASON}`,
        };
      }
      const activeCommands = activeCommandCount();
      if (activeCommands >= BACKGROUND_COMMAND_MAX_CONCURRENT) {
        return {
          ok: false,
          errorCode: 'TOO_MANY_RUNS',
          message: `already ${activeCommands} background commands running (max ${BACKGROUND_COMMAND_MAX_CONCURRENT})`,
        };
      }
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? BACKGROUND_COMMAND_MAX_MS, 1000),
        BACKGROUND_COMMAND_MAX_MS,
      );
      const runId = `bg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const logDir = deps.resolveLogDir();
      const logPath = path.join(logDir, `${runId}.log`);
      const startedAt = Date.now();
      pruneOldLogs();
      // 孤儿日志巡检每秒一轮:快写者的越限窗口 ≤ 写入速率×1s,磁盘有界。
      if (!orphanPoll) {
        orphanPoll = setInterval(truncateOrphanLogs, 1000);
        orphanPoll.unref?.();
      }

      // 日志:子进程直接持有 append fd 写文件,宿主侧没有管道读端 —— 应用退出/
      // 重启不再把在跑命令的输出写断(POSIX SIGPIPE/win32 EPIPE)。体量上限改由
      // 体量巡检兜底(capPoll):超限杀树,文件有界。尾部报告在结算时读文件末尾 ——
      // 长命令的结论都在最后,不能丢。
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // 日志建不出来就兑现不了「完成时有日志可核对」:拒绝启动,不静默无日志。
        return {
          ok: false,
          errorCode: 'LOG_FAILED',
          message: `cannot create background command log (dir not writable?): ${logDir}`,
        };
      }
      let logFd: number;
      try {
        logFd = openSync(logPath, 'a');
      } catch {
        return {
          ok: false,
          errorCode: 'LOG_FAILED',
          message: `cannot open background command log (dir not writable?): ${logPath}`,
        };
      }
      const closeHostFd = (): void => {
        // 宿主自己的 fd 副本即关即了;子进程继承的副本不受影响。重复关闭按 EBADF 吞掉。
        try {
          closeSync(logFd);
        } catch {
          // already closed
        }
      };

      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          cwd: input.cwd,
          windowsHide: true,
          // stdio 直接接日志文件 fd:子进程及其后代都写同一文件,宿主重启无感。
          stdio: ['ignore', logFd, logFd],
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            // Windows 下 Python piped stdout 默认走 locale encoding(cp936/GBK),不看 chcp 65001;
            // 完成报告按 UTF-8 读尾部,不强制的话中文输出会变乱码。与 commands/builtins.ts 同一做法。
            PYTHONUTF8: process.env.PYTHONUTF8 ?? '1',
            PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? 'utf-8',
          },
        });
      } catch (error) {
        closeHostFd();
        return {
          ok: false,
          errorCode: 'SPAWN_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // spawn 成功后宿主立即关掉自己的 fd 副本;子进程的继承副本不受影响。
      child.once('spawn', closeHostFd);

      // spawn error 与 close 在个别路径可能都到达;同一次 run 只回注一份报告,
      // 且时长在退出时刻定格(不含排队/重试等待),报告各次重试内容一致。
      const durationMs = () => Date.now() - startedAt;
      let reportSent = false;
      // 报告尾部从文件末尾读:子进程直写,宿主没有内存副本。读不到(文件被外部
      // 清掉等)按空尾部处理,报告主体不受影响。
      const readLogTail = (): string => {
        try {
          const size = statSync(logPath).size;
          const start = Math.max(0, size - TAIL_CAP_BYTES);
          const length = Math.min(size, TAIL_CAP_BYTES);
          const buffer = Buffer.alloc(length);
          const handle = openSync(logPath, 'r');
          try {
            readSync(handle, buffer, 0, length, start);
          } finally {
            closeSync(handle);
          }
          return buffer.toString('utf8');
        } catch {
          return '';
        }
      };
      const reportOnce = (exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        spawnError?: string;
      }) => {
        if (reportSent) return;
        reportSent = true;
        deliverReport({
          sessionId: input.sessionId,
          runId,
          command,
          logPath,
          logTruncated: outputCapped,
          durationMs: durationMs(),
          exit,
          tail: readLogTail(),
        });
      };

      // 名额与硬顶治理整棵树（含 `&` 脱离的后代）分两本账：并发名额在命令 exit 时
      // 让出（报告即时回注，新命令不被已死命令堵住）；治理（硬顶杀树 / POSIX 组探测）
      // 留到树死透或硬顶到点才整体移除。
      let groupPoll: NodeJS.Timeout | null = null;
      const releaseSlot = () => {
        const entry = running.get(runId);
        if (entry) entry.active = false;
      };
      const endGovernance = () => {
        if (!running.has(runId)) return;
        running.delete(runId);
        clearTimeout(timeoutTimer);
        if (groupPoll) clearInterval(groupPoll);
        clearInterval(capPoll);
      };
      if (process.platform !== 'win32' && child.pid) {
        // detached(setsid)后整棵树同组，组 id = shell pid；组空即树死透。
        // Windows 无轻量等价探测，治理计时器占到硬顶（名额已在 exit 让出）。
        const checkGroupGone = () => {
          try {
            process.kill(-child.pid!, 0);
          } catch {
            // 树死透：整体移除（治理对象已不存在）。
            endGovernance();
          }
        };
        const firstCheck = setTimeout(checkGroupGone, 1_000);
        firstCheck.unref?.();
        groupPoll = setInterval(checkGroupGone, 30_000);
        groupPoll.unref?.();
      }
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        // child 已退出时 killProcessTree 不再按 PID 查杀后代(仓库既有约定,防
        // PID 复用误杀):Windows 上自行脱离的后代因此不受硬顶治理,记日志留痕。
        // POSIX 不同:detached 进程组仍在,可按组清理(组可能已空,则什么也没杀)。
        const childAlive =
          typeof child.exitCode !== 'number' && typeof child.signalCode !== 'string';
        killProcessTree(child.pid, child, () => {});
        deps.logger.warn?.(
          childAlive
            ? '[background-command] killed after hard cap (process tree included)'
            : process.platform === 'win32'
              ? '[background-command] hard cap reached after command exit; detached descendants are not tracked'
              : '[background-command] hard cap reached after command exit; cleared remaining process group (if any)',
          { runId, platform: process.platform },
        );
        endGovernance();
      }, timeoutMs);
      timeoutTimer.unref?.();

      // 体量巡检(替代管道时代的转写截断):输出是子进程直写文件,宿主拦不住写入,
      // 只能看体量——超上限即按异常输出杀树,`yes` 之类的裸输出写不穿磁盘。巡检
      // 持续到治理结束:shell 已退而后代仍持 fd 续写时,POSIX 按组清得掉;Windows
      // 按既有约定查杀不到后代,只记日志留痕(与硬顶治理同一口径)。
      let outputCapped = false;
      const capPoll = setInterval(() => {
        if (outputCapped) return;
        try {
          if (statSync(logPath).size <= BACKGROUND_COMMAND_LOG_CAP_BYTES) return;
        } catch {
          return; // stat 失败的 tick 跳过(文件被外部移动等)
        }
        outputCapped = true;
        deps.logger.warn?.(
          '[background-command] output log exceeded cap; killing process tree',
          { runId, logPath },
        );
        killProcessTree(child.pid, child, () => {});
      }, 500);
      capPoll.unref?.();

      // 结算以 exit(进程退出)为准。注意：结算只管报告，名额在 exit 让出
      // （releaseSlot），治理由 timeoutTimer/组探测继续，不随后代一起结束。
      let settled = false;
      const settle = (exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        spawnError?: string;
      }) => {
        if (settled) return;
        settled = true;
        // stdio 直写文件后没有 pipe EOF 要等;短延迟只为读尾部时避开杀毒/索引器
        // 的瞬时文件锁。
        const grace = setTimeout(() => reportOnce(exit), SETTLE_READ_DELAY_MS);
        grace.unref?.();
      };

      running.set(runId, {
        startedAt,
        logPath,
        timeoutTimer,
        groupPoll,
        capPoll,
        killTree: () => killProcessTree(child.pid, child, () => {}),
        active: true,
      });
      child.once('exit', (code, signal) => {
        // 命令已退出即让出并发名额：报告跟着回注，新命令不被死名额堵住。
        releaseSlot();
        settle({ code, signal, timedOut });
      });
      child.once('error', (error) => {
        deps.logger.warn?.('[background-command] spawn error', { runId, error: error.message });
        // spawn 失败没有进程树，直接整体移除；kill 失败等后续 error 不影响幂等性。
        endGovernance();
        closeHostFd();
        settle({ code: null, signal: null, timedOut: false, spawnError: error.message });
      });
      return { ok: true, runId, logPath, pid: child.pid };
    },

    runningCount(): number {
      return activeCommandCount();
    },

    /**
     * 账号边界作废:杀掉在途进程树、清掉硬顶计时器、丢弃待投递报告。
     * 切号后旧账号的运行不能继续占用并发名额(否则新账号直接 TOO_MANY_RUNS),
     * 报告也不能投进新账号;单例引用由调用方清空,下次懒建全新服务。
     */
    dispose(): void {
      disposed = true;
      if (orphanPoll) clearInterval(orphanPoll);
      for (const [runId, entry] of running) {
        clearTimeout(entry.timeoutTimer);
        // POSIX 的进程组探测定时器一并清掉：记录已删后 releaseSlot 查不到条目，
        // 不清的话每 30s 的轮询会带着闭包活到进程退出。
        if (entry.groupPoll) clearInterval(entry.groupPoll);
        clearInterval(entry.capPoll);
        try {
          entry.killTree();
        } catch {
          // child 已退出时 killProcessTree 本就是 no-op;这里只防拒绁性异常。
        }
        running.delete(runId);
      }
    },
  };
}

export type BackgroundCommandService = ReturnType<typeof createBackgroundCommandService>;
