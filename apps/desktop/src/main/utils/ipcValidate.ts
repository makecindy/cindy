import type { IpcErrorCode } from '../../shared/ipc-errors.js';

/**
 * IPC 参数运行时校验工具 — main 进程所有 IPC handler 共用。
 */

/** 抛出带 code 的 IPC 错误，renderer 侧可通过 err.code 做统一处理 */
export function throwIpcError(code: IpcErrorCode, message: string): never {
  const err = new Error(`[${code}] ${message}`);
  (err as { code?: IpcErrorCode }).code = code;
  throw err;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throwIpcError('INVALID_PARAMS', `${name} is required`);
  }
  return value;
}

export function requireObject(value: unknown, name = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throwIpcError('INVALID_PARAMS', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Non-negative integer. Common shape across IPC handlers (positions, ids, etc.). */
export function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-negative integer`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throwIpcError(
      'INVALID_PARAMS',
      `invalid ${name}: ${String(value)} (expected ${allowed.join(' | ')})`,
    );
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  return requireEnum(value, allowed, name);
}
