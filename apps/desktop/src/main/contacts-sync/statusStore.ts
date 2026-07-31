/** 同步成功摘要与同机跨实例运行态。只含状态/设备显示信息，不含任何通讯录内容。 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const FILE_NAME = 'contacts-device-sync-status.v1.json';
const RUNTIME_FILE_NAME = 'contacts-device-sync-runtime.v1.json';
const SYNC_REQUEST_FILE_NAME = 'contacts-device-sync-request.v1';

export interface PersistedContactsSyncStatus {
  lastSyncAt: string | null;
  lastSyncDeviceId: string | null;
  lastSyncDeviceName: string | null;
  lastRoute: 'lan' | 'relay' | null;
}

/** Device Link 持有者给同机被动实例看的无内容运行态。 */
export interface PersistedContactsSyncRuntimeStatus extends PersistedContactsSyncStatus {
  available: boolean;
  enabled: boolean;
  phase: 'off' | 'waiting' | 'syncing' | 'up-to-date' | 'error';
  onlineDeviceCount: number;
  errorCode: 'secure-storage-unavailable' | 'peer-identity-changed' | 'sync-failed' | null;
  updatedAt: number;
}

const EMPTY_STATUS: PersistedContactsSyncStatus = {
  lastSyncAt: null,
  lastSyncDeviceId: null,
  lastSyncDeviceName: null,
  lastRoute: null,
};

export function readPersistedContactsSyncStatus(): PersistedContactsSyncStatus {
  const file = statusPath();
  if (!file || !fs.existsSync(file)) return { ...EMPTY_STATUS };
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(value)) return { ...EMPTY_STATUS };
    return {
      lastSyncAt: boundedNullableText(value.lastSyncAt, 64),
      lastSyncDeviceId: boundedNullableText(value.lastSyncDeviceId, 160),
      lastSyncDeviceName: boundedNullableText(value.lastSyncDeviceName, 256),
      lastRoute: value.lastRoute === 'lan' || value.lastRoute === 'relay' ? value.lastRoute : null,
    };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

export function writePersistedContactsSyncStatus(status: PersistedContactsSyncStatus): void {
  const file = statusPath(FILE_NAME);
  if (!file) return;
  writeAtomic(file, JSON.stringify(status, null, 2));
}

export function readPersistedContactsSyncRuntimeStatus(): PersistedContactsSyncRuntimeStatus | null {
  const file = statusPath(RUNTIME_FILE_NAME);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(value)) return null;
    const phase = runtimePhase(value.phase);
    const errorCode = runtimeErrorCode(value.errorCode);
    if (
      typeof value.available !== 'boolean' ||
      typeof value.enabled !== 'boolean' ||
      !phase ||
      !Number.isInteger(value.onlineDeviceCount) ||
      (value.onlineDeviceCount as number) < 0 ||
      (value.onlineDeviceCount as number) > 10_000 ||
      !Number.isFinite(value.updatedAt) ||
      (value.updatedAt as number) <= 0 ||
      (value.errorCode !== null && !errorCode)
    ) {
      return null;
    }
    return {
      available: value.available,
      enabled: value.enabled,
      phase,
      onlineDeviceCount: value.onlineDeviceCount as number,
      errorCode,
      updatedAt: value.updatedAt as number,
      lastSyncAt: boundedNullableText(value.lastSyncAt, 64),
      lastSyncDeviceId: boundedNullableText(value.lastSyncDeviceId, 160),
      lastSyncDeviceName: boundedNullableText(value.lastSyncDeviceName, 256),
      lastRoute: value.lastRoute === 'lan' || value.lastRoute === 'relay' ? value.lastRoute : null,
    };
  } catch {
    return null;
  }
}

export function writePersistedContactsSyncRuntimeStatus(
  status: PersistedContactsSyncRuntimeStatus,
): void {
  const file = statusPath(RUNTIME_FILE_NAME);
  if (!file) return;
  writeAtomic(file, JSON.stringify(status));
}

/** 被动实例写一次性 token；内容不含联系人，最后写入获胜即可。 */
export function writeContactsSyncRequestToken(): void {
  const file = statusPath(SYNC_REQUEST_FILE_NAME);
  if (!file) return;
  writeAtomic(file, randomUUID());
}

export function readContactsSyncRequestToken(): string | null {
  const file = statusPath(SYNC_REQUEST_FILE_NAME);
  if (!file) return null;
  try {
    const value = fs.readFileSync(file, 'utf8');
    return value.length > 0 && value.length <= 64 ? value : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // rename 成功后临时文件已不存在；失败清理也只能 best-effort。
    }
  }
}

function statusPath(fileName = FILE_NAME): string | null {
  return getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath(fileName) : null;
}

function boundedNullableText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimePhase(value: unknown): PersistedContactsSyncRuntimeStatus['phase'] | null {
  return value === 'off' ||
    value === 'waiting' ||
    value === 'syncing' ||
    value === 'up-to-date' ||
    value === 'error'
    ? value
    : null;
}

function runtimeErrorCode(
  value: unknown,
): PersistedContactsSyncRuntimeStatus['errorCode'] {
  return value === 'secure-storage-unavailable' ||
    value === 'peer-identity-changed' ||
    value === 'sync-failed'
    ? value
    : null;
}
