/** 最近一次成功同步信息。只含设备显示名/时间/路由，不含任何通讯录内容。 */

import fs from 'node:fs';
import path from 'node:path';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const FILE_NAME = 'contacts-device-sync-status.v1.json';

export interface PersistedContactsSyncStatus {
  lastSyncAt: string | null;
  lastSyncDeviceId: string | null;
  lastSyncDeviceName: string | null;
  lastRoute: 'lan' | 'relay' | null;
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
  const file = statusPath();
  if (!file) return;
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(status, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function statusPath(): string | null {
  return getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath(FILE_NAME) : null;
}

function boundedNullableText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
