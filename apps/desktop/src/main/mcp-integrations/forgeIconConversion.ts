import { randomUUID } from 'node:crypto';

import { GHOST_ICON_MAX_BYTES } from '../../shared/ghost.js';
import type {
  ForgeIconConversionRequest,
  ForgeIconConversionResponse,
} from './forgeIconConversionProtocol.js';

export const FORGE_ICON_CONVERT_TIMEOUT_MS = 5_000;
/**
 * 失败后首轮等待 utility process 回收的有界隔离窗口。调用方在请求失败时
 * 已经立即回退默认图标；窗口只保护后续转换不与旧 native 任务重叠。
 */
export const FORGE_ICON_CONVERT_TERMINATION_GRACE_MS = 1_000;
/** 首轮回收窗口内的 PID 探活间隔。 */
export const FORGE_ICON_CONVERT_TERMINATION_POLL_MS = 100;
/** 无法确认死亡时的低频 quarantine 探活间隔。 */
export const FORGE_ICON_CONVERT_QUARANTINE_POLL_MS = 1_000;

export interface ForgeIconConversionChildLike {
  pid?: number;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (type: string, location: string, report: string) => void): void;
  kill(): boolean;
}

interface ForgeIconConverterOptions {
  fork: () => ForgeIconConversionChildLike;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /** 测试可注入；生产默认使用 process.kill(pid, 0)。 */
  isPidAlive?: (pid: number) => boolean;
}

interface ActiveForgeIconConversion {
  child: ForgeIconConversionChildLike;
  id: string;
  settled: boolean;
  lastKnownPid?: number;
  timer?: ReturnType<typeof setTimeout>;
  terminationTimer?: ReturnType<typeof setTimeout>;
  terminationStartedAt?: number;
  terminationEscalated?: boolean;
}

/**
 * 一次只运行一个隔离转换进程；繁忙时直接回退默认图标，不排队。
 * Sharp/libvips 不在 Electron main 内运行：wall-clock 超时会 kill 整个 utility
 * process，锁由子进程 exit 或确认 PID 已死亡后释放，不依赖可能永不 settle 的
 * native promise。若系统无法确认 PID 已死亡，进入低频 quarantine，宁可继续
 * 回退默认图标，也不与仍可能存活的旧 native 任务并发。
 */
export function createForgeIconConverter(options: ForgeIconConverterOptions) {
  const timeoutMs = options.timeoutMs ?? FORGE_ICON_CONVERT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GHOST_ICON_MAX_BYTES;
  const terminationGraceMs = Math.max(
    1,
    options.terminationGraceMs ?? FORGE_ICON_CONVERT_TERMINATION_GRACE_MS,
  );
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nativeTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  let active: ActiveForgeIconConversion | null = null;

  return async function convertForgeIconToPng(absPath: string): Promise<Buffer> {
    if (active) throw new Error('AI 图标转换繁忙，已使用默认图标');

    let child: ForgeIconConversionChildLike;
    try {
      child = options.fork();
    } catch (error) {
      throw new Error(`AI 图标转换进程启动失败:${errorMessage(error)}`);
    }

    const initialPid = child.pid;
    const state: ActiveForgeIconConversion = {
      child,
      id: randomUUID(),
      settled: false,
      lastKnownPid: isValidPid(initialPid) ? initialPid : undefined,
    };
    active = state;

    return new Promise<Buffer>((resolve, reject) => {
      const clearTimer = (): void => {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
      };
      const clearTerminationTimer = (): void => {
        if (state.terminationTimer !== undefined) {
          clearTimeout(state.terminationTimer);
          state.terminationTimer = undefined;
        }
      };
      const release = (): void => {
        clearTerminationTimer();
        if (active === state) active = null;
      };
      const rememberPid = (): number | undefined => {
        const currentPid = child.pid;
        if (isValidPid(currentPid)) state.lastKnownPid = currentPid;
        return state.lastKnownPid;
      };
      const childIsKnownDead = (): boolean => {
        const pid = rememberPid();
        if (pid === undefined) return false;
        try {
          return !isPidAlive(pid);
        } catch {
          // 探活失败时按 alive/unknown 处理，避免与仍可能存活的旧进程并发。
          return false;
        }
      };
      const scheduleTerminationPoll = (delayMs: number): void => {
        if (active !== state) return;
        clearTerminationTimer();
        state.terminationTimer = setTimeout(() => {
          state.terminationTimer = undefined;
          pollTermination();
        }, delayMs);
        state.terminationTimer.unref?.();
      };
      const pollTermination = (): void => {
        if (active !== state) return;
        if (childIsKnownDead()) {
          // 只有明确确认 PID 已不存在时，才能在缺失 exit 事件的情况下释放
          // 单飞槽；这也避免 PID 被复用时误判旧进程已结束。
          release();
          return;
        }

        const startedAt = state.terminationStartedAt ?? Date.now();
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs < terminationGraceMs) {
          scheduleTerminationPoll(
            Math.min(FORGE_ICON_CONVERT_TERMINATION_POLL_MS, terminationGraceMs - elapsedMs),
          );
          return;
        }

        if (!state.terminationEscalated) {
          state.terminationEscalated = true;
          try {
            // 首轮窗口仍存活时再 best-effort kill 一次；不直接按 PID 发信号，
            // 避免 PID reuse 误杀无关进程。
            child.kill();
          } catch {
            // 继续 quarantine，直到 exit 或探活明确确认 PID 已死亡。
          }
        }
        scheduleTerminationPoll(FORGE_ICON_CONVERT_QUARANTINE_POLL_MS);
      };
      const requestTermination = (): void => {
        if (state.terminationStartedAt !== undefined) return;
        state.terminationStartedAt = Date.now();
        // Electron 会在进程结束后把 child.pid 清空；kill 前保存最后一次有效值，
        // 即使 exit 事件丢失，后续探活仍能确认旧进程已经消失。
        rememberPid();
        try {
          child.kill();
        } catch {
          // 仍进入有界隔离窗口；当前请求已经失败，后续调用暂时走默认图标回退。
        }
        pollTermination();
      };
      const complete = (operation: () => void): void => {
        if (state.settled) return;
        state.settled = true;
        clearTimer();
        // Keep the slot occupied until exit or a confirmed-dead PID. The response
        // can arrive just before the process is reaped; releasing here could start
        // a second Sharp process while the first one is shutting down.
        requestTermination();
        operation();
      };
      const failAndTerminate = (error: Error): void => {
        if (state.settled) return;
        state.settled = true;
        clearTimer();
        // 超时/请求失败时不能在 kill 请求后立刻释放：先等 Electron 确认 exit
        // 或 PID 已死亡，防止旧 native 任务尚未停止时立刻启动第二个子进程。
        // 当前请求已经立即拒绝，由上层回退默认图标。
        requestTermination();
        reject(error);
      };

      child.on('message', (message) => {
        const response = parseForgeIconConversionResponse(message, state.id);
        if (!response) return;
        if (!response.ok) {
          complete(() => reject(new Error(response.error)));
          return;
        }
        const png = Buffer.from(response.png);
        if (png.byteLength === 0 || png.byteLength > maxOutputBytes) {
          complete(() => reject(new Error(`AI 图标转换结果必须在 1–${maxOutputBytes} 字节之间`)));
          return;
        }
        complete(() => resolve(png));
      });
      child.on('error', (type, location) => {
        const error = new Error(`AI 图标转换进程异常:${type}${location ? `(${location})` : ''}`);
        if (!state.settled) failAndTerminate(error);
        // 当前请求已在 failAndTerminate 中立即拒绝；槽位等 exit 或确认 PID
        // 已死亡后释放，防止 error 后旧进程尚未退出时立刻启动第二个进程。
      });
      child.on('exit', (code) => {
        clearTimer();
        release();
        if (state.settled) return;
        state.settled = true;
        reject(new Error(`AI 图标转换进程已退出(${code})`));
      });

      state.timer = setTimeout(() => {
        failAndTerminate(new Error(`AI 图标转换超时(${timeoutMs}ms)`));
      }, timeoutMs);
      state.timer.unref?.();

      const request: ForgeIconConversionRequest = {
        kind: 'convert',
        id: state.id,
        absPath,
        timeoutSeconds: nativeTimeoutSeconds,
      };
      try {
        child.postMessage(request);
      } catch (error) {
        failAndTerminate(new Error(`AI 图标转换请求失败:${errorMessage(error)}`));
      }
    });
  };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 只有 ESRCH 能证明 PID 已不存在；EPERM、EINVAL 等未知结果一律
    // 按存活/未知处理，避免在旧 utility process 仍可能运行时启动新进程。
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isValidPid(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}

function parseForgeIconConversionResponse(
  value: unknown,
  expectedId: string,
): ForgeIconConversionResponse | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ForgeIconConversionResponse>;
  if (candidate.kind !== 'result' || candidate.id !== expectedId) return null;
  if (candidate.ok === false) {
    return typeof candidate.error === 'string' && candidate.error.length > 0
      ? (candidate as Extract<ForgeIconConversionResponse, { ok: false }>)
      : null;
  }
  if (candidate.ok !== true || !(candidate.png instanceof Uint8Array)) return null;
  return candidate as Extract<ForgeIconConversionResponse, { ok: true }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
