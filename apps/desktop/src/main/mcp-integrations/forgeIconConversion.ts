import { randomUUID } from 'node:crypto';

import { GHOST_ICON_MAX_BYTES } from '../../shared/ghost.js';
import type {
  ForgeIconConversionRequest,
  ForgeIconConversionResponse,
} from './forgeIconConversionProtocol.js';

export const FORGE_ICON_CONVERT_TIMEOUT_MS = 5_000;

export interface ForgeIconConversionChildLike {
  pid?: number;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(
    event: 'error',
    listener: (type: string, location: string, report: string) => void,
  ): void;
  kill(): boolean;
}

interface ForgeIconConverterOptions {
  fork: () => ForgeIconConversionChildLike;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ActiveForgeIconConversion {
  child: ForgeIconConversionChildLike;
  id: string;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 一次只运行一个隔离转换进程；繁忙时直接回退默认图标，不排队。
 * Sharp/libvips 不在 Electron main 内运行：wall-clock 超时会 kill 整个 utility
 * process，锁由子进程 exit 释放，不依赖可能永不 settle 的 native promise。
 */
export function createForgeIconConverter(options: ForgeIconConverterOptions) {
  const timeoutMs = options.timeoutMs ?? FORGE_ICON_CONVERT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GHOST_ICON_MAX_BYTES;
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

    const state: ActiveForgeIconConversion = {
      child,
      id: randomUUID(),
      settled: false,
    };
    active = state;

    return new Promise<Buffer>((resolve, reject) => {
      const release = (): void => {
        if (active === state) active = null;
      };
      const clearTimer = (): void => {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
      };
      const requestTermination = (): boolean => {
        try {
          return child.kill();
        } catch {
          // 子进程已不可用时，调用方会立即释放槽位；不能把异常吞掉后永久 busy。
          return false;
        }
      };
      const complete = (operation: () => void): void => {
        if (state.settled) return;
        state.settled = true;
        clearTimer();
        // Keep the slot occupied until the child emits exit. The response can
        // arrive just before the process is reaped; releasing here could start
        // a second Sharp process while the first one is still shutting down.
        if (!requestTermination()) release();
        operation();
      };
      const failAndTerminate = (error: Error): void => {
        if (state.settled) return;
        state.settled = true;
        clearTimer();
        // 超时/请求失败时不能在 kill 请求后立刻释放：等 Electron 确认 exit，
        // 防止旧 native 任务尚未停止时新请求又启动一个子进程。FatalError 的
        // error 监听器另有无 exit 兜底，避免异常路径永久占槽。
        if (!requestTermination()) release();
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
          complete(() =>
            reject(new Error(`AI 图标转换结果必须在 1–${maxOutputBytes} 字节之间`)),
          );
          return;
        }
        complete(() => resolve(png));
      });
      child.on('error', (type, location) => {
        const error = new Error(`AI 图标转换进程异常:${type}${location ? `(${location})` : ''}`);
        if (!state.settled) failAndTerminate(error);
        // Electron 通常会随后发 exit，但 FatalError 路径在测试/部分平台上
        // 可能只有 error。把它视为同一终止路径，避免一次异常永久占住转换槽；
        // exit 后的 release 仍是幂等的(active === state 才会清理)。
        release();
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
