/**
 * dws 进程能力的注入契约。
 *
 * @cindy/im 不负责在 PATH 里找 dws、也不决定怎么拉起进程（Windows .exe 解析、
 * 进程树清理都是宿主平台细节），只通过本接口驱动它。测试注入假 runner。
 */

import type { Readable } from 'node:stream';

/** dws 以 `{ error: {...} }` 形态报告的业务 / 校验错误。 */
export class DwsCommandError extends Error {
  constructor(
    /** 服务端 code（如 DIGITAL_EMPLOYEE_NOT_ENABLED）或 dws reason（如 unknown_flag）。 */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DwsCommandError';
  }
}

/** 本机没有可用的 dws 可执行文件。 */
export const DWS_NOT_INSTALLED = 'DWS_NOT_INSTALLED';

export interface DwsStreamProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 关闭 stdin = dws 文档约定的优雅停机（会顺带退订本次新建的订阅）。 */
  closeStdin(): void;
  /** 优雅停机超时后的兜底强杀（宿主负责整棵进程树）。 */
  forceKill(): void;
  onExit(handler: (code: number | null) => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface DwsRunner {
  /** 本机是否能找到 dws 可执行文件。 */
  isAvailable(): Promise<boolean>;
  /**
   * 运行一次性 dws 命令并返回解析后的 JSON。
   * 找不到 dws 时以 message 为 DWS_NOT_INSTALLED 的 Error 拒绝；
   * dws 返回 error 对象时以 DwsCommandError 拒绝。
   */
  runJson(args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<unknown>;
  /** 拉起长驻的事件流进程。 */
  spawnStream(args: readonly string[]): DwsStreamProcess;
}

/**
 * 把 dws 的 stdout 解析成 JSON；遇到 `{ error }` 抛 DwsCommandError。
 * 宿主 runner 复用这一个实现，保证错误口径一致。
 */
export function parseDwsJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new DwsCommandError('empty_output', 'dws returned no output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DwsCommandError('invalid_output', 'dws returned non-JSON output');
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, unknown>).error;
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const code =
        (typeof record.server_error_code === 'string' && record.server_error_code) ||
        (typeof record.reason === 'string' && record.reason) ||
        'dws_error';
      const message = typeof record.message === 'string' ? record.message : code;
      throw new DwsCommandError(code, message);
    }
  }
  return parsed;
}
