import type { DbClient } from './DbClient.js';

export type CurrentDbClientSnapshot = {
  client: DbClient;
  userId: string;
  clientEpoch: number;
};

let clientEpoch = 0;
let current: CurrentDbClientSnapshot | null = null;

export function setCurrentDbClient(client: DbClient, userId: string): void {
  clientEpoch += 1;
  current = { client, userId, clientEpoch };
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
