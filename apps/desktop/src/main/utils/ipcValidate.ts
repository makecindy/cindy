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

/**
 * 必填、但允许显式 `null` 的字符串。
 *
 * 与 `optionalNullableString` 的区别是**字段缺失即报错**。用在「没传」与「显式
 * 传 null」语义不同的地方 —— 尤其是 null 代表一个破坏性动作时(如清空用户已保存
 * 的设置): 把缺字段当 null,调用方的一次疏忽就变成一次静默的清除。
 * 非字符串值同样拒绝, 不做 String() 强转(`123` 会命中名叫 "123" 的合法别名)。
 */
export function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireString(value, name);
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
