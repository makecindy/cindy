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
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { killProcessTree } from '../scheduler-host/proc-util.js';
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
const REPORT_RETRY_MAX = 10;
/** 日志保留天数;过期文件在服务使用时清理(报告可能已消费,磁盘不应无限涨)。 */
const LOG_RETENTION_DAYS = 14;

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
  | { ok: false; errorCode: 'INVALID_ARGS' | 'TOO_MANY_RUNS' | 'SPAWN_FAILED'; message: string };

export interface BackgroundCommandServiceDeps {
  /** scheduler 撞忙排队桥的导出薄封装;会话忙则排队、空闲即派发。 */
  enqueueReport: (
    req: SchedulerQueuedPromptRequest,
  ) => Promise<{ clientId: string } | { duplicate: true } | { retry: true }>;
  /** 日志目录按当前账号解析(owner 隔离);每次 start 时现取,账号切换后落到新目录。 */
  resolveLogDir: () => string;
  logger: {
    info?(message: string, data?: unknown): void;
    warn?(message: string, data?: unknown): void;
  };
}

export function createBackgroundCommandService(deps: BackgroundCommandServiceDeps) {
  const running = new Map<string, { startedAt: number; timeoutTimer: NodeJS.Timeout }>();

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

  function buildReport(input: {
    command: string;
    logPath: string;
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
    const text =
      `〔后台命令完成〕这条消息由宿主在后台命令结束时自动发来，不是主人输入。\n` +
      `命令：${head}\n状态：${status}\n耗时：${duration}\n` +
      (input.tail.trim() ? `日志尾部：\n---\n${input.tail}\n---\n` : '') +
      `完整日志：${input.logPath}\n` +
      `请根据结果继续推进任务；不需要主人决策时向主人简短汇报即可。`;
    return { text, persistedContent: `后台命令完成 · ${status} · ${head}` };
  }

  function deliverReport(params: {
    sessionId: string;
    runId: string;
    command: string;
    logPath: string;
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
        if (attempts > REPORT_RETRY_MAX) {
          deps.logger.warn?.('[background-command] report delivery gave up after retries', {
            runId: params.runId,
            attempts,
          });
          return;
        }
        const timer = setTimeout(() => void attempt(), REPORT_RETRY_DELAY_MS);
        timer.unref?.();
      }
    };
    void attempt();
  }

  return {
    start(input: BackgroundCommandStartInput): BackgroundCommandStartResult {
      const command = input.command?.trim();
      if (!command || !input.sessionId || !input.cwd) {
        return {
          ok: false,
          errorCode: 'INVALID_ARGS',
          message: 'command, sessionId and cwd are required',
        };
      }
      if (running.size >= BACKGROUND_COMMAND_MAX_CONCURRENT) {
        return {
          ok: false,
          errorCode: 'TOO_MANY_RUNS',
          message: `already ${running.size} background commands running (max ${BACKGROUND_COMMAND_MAX_CONCURRENT})`,
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

      // 日志:stdio 走 pipe 由宿主转写,文件保头部(5MB 上限),内存保尾部(64KB)供
      // 完成报告用 —— 长命令的结论都在最后,文件截断不能让报告丢结论。
      // 同步建目录+流:attach 在下一行就要接住首批 data,不能让初始化输给第一个 chunk。
      let writer: ReturnType<typeof createWriteStream> | null = null;
      let fileBytes = 0;
      let markerWritten = false;
      let tail = Buffer.alloc(0);
      try {
        mkdirSync(logDir, { recursive: true });
        writer = createWriteStream(logPath, { flags: 'a' });
        writer.on('error', () => {
          writer = null;
        });
      } catch {
        writer = null;
      }
      const attach = (stream: NodeJS.ReadableStream | null): void => {
        stream?.on('data', (chunk: Buffer) => {
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > TAIL_CAP_BYTES) tail = tail.subarray(tail.length - TAIL_CAP_BYTES);
          if (!writer || writer.destroyed) return;
          if (fileBytes >= BACKGROUND_COMMAND_LOG_CAP_BYTES) {
            // 恰好按 chunk 边界对齐到上限时走这里;标记不能只写在跨越分支。
            if (!markerWritten) {
              markerWritten = true;
              writer.write(
                `\n[log truncated at ${BACKGROUND_COMMAND_LOG_CAP_BYTES} bytes; later output discarded]\n`,
              );
            }
            return;
          }
          let piece = chunk;
          if (fileBytes + piece.length > BACKGROUND_COMMAND_LOG_CAP_BYTES) {
            piece = piece.subarray(0, BACKGROUND_COMMAND_LOG_CAP_BYTES - fileBytes);
            fileBytes = BACKGROUND_COMMAND_LOG_CAP_BYTES;
            if (!markerWritten) {
              markerWritten = true;
              writer.write(
                `\n[log truncated at ${BACKGROUND_COMMAND_LOG_CAP_BYTES} bytes; later output discarded]\n`,
              );
            }
          } else {
            fileBytes += piece.length;
          }
          writer.write(piece);
        });
        stream?.on('error', () => {});
      };

      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          cwd: input.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: 'SPAWN_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      attach(child.stdout);
      attach(child.stderr);

      // spawn error 与 close 在个别路径可能都到达;同一次 run 只回注一份报告,
      // 且时长在退出时刻定格(不含排队/重试等待),报告各次重试内容一致。
      const durationMs = () => Date.now() - startedAt;
      let reportSent = false;
      const reportOnce = (exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        spawnError?: string;
      }) => {
        if (reportSent) return;
        reportSent = true;
        const settledDurationMs = durationMs();
        const reportTail = () => (tail.length ? tail.toString('utf8') : '');
        if (writer && !writer.destroyed) {
          writer.end(() =>
            deliverReport({
              sessionId: input.sessionId,
              runId,
              command,
              logPath,
              durationMs: settledDurationMs,
              exit,
              tail: reportTail(),
            }),
          );
        } else {
          deliverReport({
            sessionId: input.sessionId,
            runId,
            command,
            logPath,
            durationMs: settledDurationMs,
            exit,
            tail: reportTail(),
          });
        }
      };

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, child, () => {});
      }, timeoutMs);
      timeoutTimer.unref?.();

      running.set(runId, { startedAt, timeoutTimer });
      child.once('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        running.delete(runId);
        reportOnce({ code, signal, timedOut });
      });
      child.once('error', (error) => {
        clearTimeout(timeoutTimer);
        running.delete(runId);
        deps.logger.warn?.('[background-command] spawn error', { runId, error: error.message });
        reportOnce({ code: null, signal: null, timedOut: false, spawnError: error.message });
      });
      return { ok: true, runId, logPath, pid: child.pid };
    },

    runningCount(): number {
      return running.size;
    },
  };
}

export type BackgroundCommandService = ReturnType<typeof createBackgroundCommandService>;
