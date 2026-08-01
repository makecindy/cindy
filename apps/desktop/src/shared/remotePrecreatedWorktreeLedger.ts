export const REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS = {
  LIST: 'remote-precreated-worktree-ledger:list',
  REGISTER: 'remote-precreated-worktree-ledger:register',
  FORGET: 'remote-precreated-worktree-ledger:forget',
} as const;

interface PendingRemotePrecreatedWorktreeBase {
  deviceId: string;
  sessionId: string;
  createdAt: number;
  /**
   * Cindy account/local-data owner that created the obligation.
   *
   * Optional only for the one-time migration of records written by older
   * renderers. New records must carry this field before Main persists them.
   */
  dataOwnerId?: string;
}

export type PendingRemotePrecreatedWorktree =
  PendingRemotePrecreatedWorktreeBase & (
    | {
        /** worktree:create 回包后可用；旧账本只有该定位符。 */
        path: string;
        recoveryKey?: string;
      }
    | {
        path?: never;
        /** worktree:create 前持久化的新定位符。 */
        recoveryKey: string;
      }
  );

export type PendingRemotePrecreatedWorktreeTarget =
  Pick<PendingRemotePrecreatedWorktree, 'deviceId' | 'sessionId'> & {
    dataOwnerId?: string;
    path?: string;
    recoveryKey?: string;
    createdAt?: number;
  };

export interface RemotePrecreatedWorktreeLedgerSnapshot {
  records: PendingRemotePrecreatedWorktree[];
  storageReadable: boolean;
}

const MAX_RECORDS = 32;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_DATA_OWNER_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MIN_RECOVERY_KEY_LENGTH = 16;
const MAX_RECOVERY_KEY_LENGTH = 256;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function readRecoveryKey(value: unknown): string | null {
  const normalized = readString(value, MAX_RECOVERY_KEY_LENGTH);
  return normalized
    && normalized.length >= MIN_RECOVERY_KEY_LENGTH
    && RECOVERY_KEY_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function remotePrecreatedWorktreeRecordKey(
  record: Pick<PendingRemotePrecreatedWorktree, 'deviceId' | 'sessionId'> & {
    dataOwnerId?: string;
  },
): string {
  return `${record.dataOwnerId ?? 'legacy'}\u0000${record.deviceId}\u0000${record.sessionId}`;
}

export function coercePendingRemotePrecreatedWorktree(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value.deviceId, MAX_DEVICE_ID_LENGTH);
  const sessionId = readString(value.sessionId, MAX_SESSION_ID_LENGTH);
  const dataOwnerId =
    value.dataOwnerId === undefined
      ? undefined
      : readString(value.dataOwnerId, MAX_DATA_OWNER_ID_LENGTH);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const recoveryKey = readRecoveryKey(value.recoveryKey);
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  if (
    !deviceId
    || !sessionId
    || (value.dataOwnerId !== undefined && !dataOwnerId)
    || (!path && !recoveryKey)
    || createdAt <= 0
  ) return null;
  if (createdAt > now + 5 * 60 * 1000) return null;
  if (now - createdAt > MAX_RECORD_AGE_MS) return null;
  const base = {
    deviceId,
    sessionId,
    createdAt,
    ...(dataOwnerId ? { dataOwnerId } : {}),
  };
  if (path) {
    return {
      ...base,
      path,
      ...(recoveryKey ? { recoveryKey } : {}),
    };
  }
  if (!recoveryKey) return null;
  return { ...base, recoveryKey };
}

export function normalizePendingRemotePrecreatedWorktrees(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree[] {
  const rawRecords =
    isRecord(value) && Array.isArray(value.records)
      ? value.records
      : Array.isArray(value)
        ? value
        : [];
  const byKey = new Map<string, PendingRemotePrecreatedWorktree>();
  for (const raw of rawRecords) {
    const record = coercePendingRemotePrecreatedWorktree(raw, now);
    if (!record) continue;
    const key = remotePrecreatedWorktreeRecordKey(record);
    const existing = byKey.get(key);
    if (!existing || record.createdAt >= existing.createdAt) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RECORDS);
}

export function coercePendingRemotePrecreatedWorktreeTarget(
  value: unknown,
): PendingRemotePrecreatedWorktreeTarget | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value.deviceId, MAX_DEVICE_ID_LENGTH);
  const sessionId = readString(value.sessionId, MAX_SESSION_ID_LENGTH);
  const dataOwnerId =
    value.dataOwnerId === undefined
      ? undefined
      : readString(value.dataOwnerId, MAX_DATA_OWNER_ID_LENGTH);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const recoveryKey = readRecoveryKey(value.recoveryKey);
  if (
    !deviceId
    || !sessionId
    || (value.dataOwnerId !== undefined && !dataOwnerId)
    || (!path && !recoveryKey)
  ) return null;
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : undefined;
  return {
    deviceId,
    sessionId,
    ...(dataOwnerId ? { dataOwnerId } : {}),
    ...(path ? { path } : {}),
    ...(recoveryKey ? { recoveryKey } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}
