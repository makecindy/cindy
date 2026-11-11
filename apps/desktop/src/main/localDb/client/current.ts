import type { DbClient } from './DbClient.js';

export type CurrentDbClientSnapshot = {
  client: DbClient;
  userId: string;
  clientEpoch: number;
};

let clientEpoch = 0;
let current: CurrentDbClientSnapshot | null = null;
const readyWaiters = new Set<() => void>();

export function setCurrentDbClient(client: DbClient, userId: string): void {
  clientEpoch += 1;
  current = { client, userId, clientEpoch };
  for (const wake of [...readyWaiters]) wake();
}

/**
 * 等当前 DbClient 出现,最多 timeoutMs;返回等到时是否已就绪。只用于启动期的有界等待
 * (例如远端首拉早于 renderer 打开 owner 数据库),不替代调用方自己的未就绪处理。
 */
export function waitForDbClient(timeoutMs: number): Promise<boolean> {
  if (current) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      readyWaiters.delete(wake);
      resolve(current !== null);
    };
    const timer = setTimeout(wake, timeoutMs);
    readyWaiters.add(wake);
  });
}

export function clearCurrentDbClient(client?: DbClient): void {
  if (client && current?.client !== client) return;
  if (current === null) return;
  clientEpoch += 1;
  current = null;
}

export function getDbClient(): DbClient {
  if (!current) {
    throw new Error('DbClient not ready');
  }
  return current.client;
}

/**
 * Database ownership can be temporarily absent during startup, logout, and
 * account switches. Keep every public boundary on one retryable classification
 * while accepting the legacy localDb wording used by older call sites.
 */
export function isDbClientNotReadyError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'HOST_NOT_READY'
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /(?:localDb|DbClient) not ready/i.test(message);
}

export function tryGetDbClient(): DbClient | null {
  return current?.client ?? null;
}

export function getCurrentDbClientUserId(): string | null {
  return current?.userId ?? null;
}

/** 同一引用上读出 client、userId 与 clientEpoch，避免分两次读赶上账号切换。 */
export function getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null {
  return current;
}
