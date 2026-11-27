export const REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS = {
  LIST: 'remote-precreated-worktree-ledger:list',
  REGISTER: 'remote-precreated-worktree-ledger:register',
  FORGET: 'remote-precreated-worktree-ledger:forget',
} as const;

export const PRECREATED_WORKTREE_PRESERVE_REASONS = [
  'claimed',
  'in-progress',
  'dirty',
  'keep-sentinel',
  'live-reference',
  'branch-mismatch',
  'include-files-changed',
  'ignored-files',
  'ephemeral',
  'pending-transfer',
  'invalid-quarantine',
  'quarantine-failed',
  'remove-failed',
] as const;

export type PrecreatedWorktreePreserveReason =
  (typeof PRECREATED_WORKTREE_PRESERVE_REASONS)[number];

export const REMOTE_PRECREATED_WORKTREE_FAILURE_KINDS = [
  'offline',
  'in-progress',
  'preserved',
  'mismatch',
  'unsupported',
  'create-started',
  'storage',
  'unknown',
] as const;

export type RemotePrecreatedWorktreeFailureKind =
  (typeof REMOTE_PRECREATED_WORKTREE_FAILURE_KINDS)[number];

const PRESERVE_REASON_SET: ReadonlySet<string> = new Set(
  PRECREATED_WORKTREE_PRESERVE_REASONS,
);
const FAILURE_KIND_SET: ReadonlySet<string> = new Set(
  REMOTE_PRECREATED_WORKTREE_FAILURE_KINDS,
);

const PRESERVE_REASON_MARKER_RE =
  /^(?:\[PRECONDITION_FAILED\]\s*)?WORKTREE_PRECREATED_PRESERVED:([a-z-]+)(?::|\s|$)/;

const PRESERVE_REASON_FALLBACK_TEXT: Record<PrecreatedWorktreePreserveReason, string> = {
  claimed: '会话已认领该 worktree，拒绝补偿回收',
  'in-progress': '上一次 worktree 创建或检出仍在进行中',
  dirty: 'worktree 已有未提交改动',
  'keep-sentinel': 'worktree 存在保留标记（.worktree-keep）',
  'live-reference': 'worktree 仍被其他任务或进程占用',
  'branch-mismatch': 'worktree 分支状态已变化或目录异常',
  'include-files-changed': 'worktree 本地配置文件与主仓库不一致',
  'ignored-files': 'worktree 包含无法复现的忽略文件',
  ephemeral: 'worktree 为受管池临时目录，拒绝补偿回收',
  'pending-transfer': 'worktree 正在迁移中',
  'invalid-quarantine': 'worktree 隔离路径状态异常',
  'quarantine-failed': 'worktree 隔离移动失败',
  'remove-failed': 'git worktree remove 拒绝删除该目录',
};

/**
 * Encode a structured preserve reason into the PRECONDITION_FAILED IPC message.
 * Keeps wire compatibility with older controllers that only inspect the IPC code.
 */
export function formatPrecreatedWorktreePreservedMessage(
  reason?: PrecreatedWorktreePreserveReason,
): string {
  if (!reason) return 'worktree 已有改动、保留标记或仍被使用';
  return `WORKTREE_PRECREATED_PRESERVED:${reason}: ${PRESERVE_REASON_FALLBACK_TEXT[reason]}`;
}

/** Parse a structured preserve reason from a PRECONDITION_FAILED IPC message, if present. */
export function parsePrecreatedWorktreePreserveReasonFromMessage(
  message: string,
): PrecreatedWorktreePreserveReason | null {
  const match = PRESERVE_REASON_MARKER_RE.exec(message.trim());
  if (!match) return null;
  const candidate = match[1];
  return PRESERVE_REASON_SET.has(candidate)
    ? (candidate as PrecreatedWorktreePreserveReason)
    : null;
}

interface PendingRemotePrecreatedWorktreeBase {
  deviceId: string;
  sessionId: string;
  createdAt: number;
  /** Missing legacy values normalize to retain-only session-create-started. */
  phase: 'reserved' | 'precreated' | 'session-create-started';
  /**
   * Cindy account/local-data owner that created the obligation.
   *
   * Optional only for the one-time migration of records written by older
   * renderers. New records must carry this field before Main persists them.
   */
  dataOwnerId?: string;
  /** Optional display name of the target device captured for recovery UI. */
  deviceName?: string;
  /** Optional last recovery failure category observed for this obligation. */
  lastFailureKind?: RemotePrecreatedWorktreeFailureKind;
  /** Optional structured remote preserve reason from the last refusal. */
  lastFailureReason?: PrecreatedWorktreePreserveReason;
  /** Optional timestamp (ms) of the last recovery failure. */
  lastFailureAt?: number;
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
const MAX_DEVICE_NAME_LENGTH = 256;
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

function readRecoveryPhase(
  value: unknown,
): PendingRemotePrecreatedWorktreeBase['phase'] | null {
  if (value === undefined) return 'session-create-started';
  return value === 'reserved' || value === 'precreated'
    || value === 'session-create-started'
    ? value
    : null;
}

function readOptionalFailureKind(
  value: unknown,
): RemotePrecreatedWorktreeFailureKind | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && FAILURE_KIND_SET.has(value)
    ? (value as RemotePrecreatedWorktreeFailureKind)
    : null;
}

function readOptionalPreserveReason(
  value: unknown,
): PrecreatedWorktreePreserveReason | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && PRESERVE_REASON_SET.has(value)
    ? (value as PrecreatedWorktreePreserveReason)
    : null;
}

function readOptionalTimestamp(
  value: unknown,
  now: number,
): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > now + 5 * 60 * 1000) return null;
  return value;
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
  const deviceName =
    value.deviceName === undefined
      ? undefined
      : readString(value.deviceName, MAX_DEVICE_NAME_LENGTH);
  const lastFailureKind = readOptionalFailureKind(value.lastFailureKind);
  const lastFailureReason = readOptionalPreserveReason(value.lastFailureReason);
  const lastFailureAt = readOptionalTimestamp(value.lastFailureAt, now);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const recoveryKey = readRecoveryKey(value.recoveryKey);
  const phase = readRecoveryPhase(value.phase);
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  if (
    !deviceId
    || !sessionId
    || (value.dataOwnerId !== undefined && !dataOwnerId)
    || (value.deviceName !== undefined && !deviceName)
    || lastFailureKind === null
    || lastFailureReason === null
    || lastFailureAt === null
    || !phase
    || (!path && !recoveryKey)
    || createdAt <= 0
  ) return null;
  if (createdAt > now + 5 * 60 * 1000) return null;
  if (now - createdAt > MAX_RECORD_AGE_MS) return null;
  const base = {
    deviceId,
    sessionId,
    createdAt,
    phase,
    ...(dataOwnerId ? { dataOwnerId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(lastFailureKind ? { lastFailureKind } : {}),
    ...(lastFailureReason ? { lastFailureReason } : {}),
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
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

/**
 * Strictly parse records read from durable storage.
 *
 * Old-but-well-formed records may be expired by normalizePending... below, but
 * an unknown/malformed record makes the whole snapshot unreadable. Silently
 * dropping a malformed cleanup obligation would allow the next remote create
 * to proceed without proving that the prior worktree is safe.
 */
export function parsePersistedPendingRemotePrecreatedWorktreeRecords(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return null;
  const seenKeys = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const deviceId = readString(raw.deviceId, MAX_DEVICE_ID_LENGTH);
    const sessionId = readString(raw.sessionId, MAX_SESSION_ID_LENGTH);
    const dataOwnerId = raw.dataOwnerId === undefined
      ? undefined
      : readString(raw.dataOwnerId, MAX_DATA_OWNER_ID_LENGTH);
    const deviceName = raw.deviceName === undefined
      ? undefined
      : readString(raw.deviceName, MAX_DEVICE_NAME_LENGTH);
    const lastFailureKind = readOptionalFailureKind(raw.lastFailureKind);
    const lastFailureReason = readOptionalPreserveReason(raw.lastFailureReason);
    const lastFailureAt = readOptionalTimestamp(raw.lastFailureAt, now);
    const path = raw.path === undefined
      ? null
      : readString(raw.path, MAX_PATH_LENGTH);
    const recoveryKey = raw.recoveryKey === undefined
      ? null
      : readRecoveryKey(raw.recoveryKey);
    const createdAt =
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : 0;
    if (
      !deviceId
      || !sessionId
      || (raw.dataOwnerId !== undefined && !dataOwnerId)
      || (raw.deviceName !== undefined && !deviceName)
      || lastFailureKind === null
      || lastFailureReason === null
      || lastFailureAt === null
      || (raw.path !== undefined && !path)
      || (raw.recoveryKey !== undefined && !recoveryKey)
      || (!path && !recoveryKey)
      || !readRecoveryPhase(raw.phase)
      || createdAt <= 0
      || createdAt > now + 5 * 60 * 1000
    ) return null;
    const key = `${dataOwnerId ?? 'legacy'}\u0000${deviceId}\u0000${sessionId}`;
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
  }
  return normalizePendingRemotePrecreatedWorktrees(value, now);
}

export function parseLegacyPendingRemotePrecreatedWorktreeLedger(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree[] | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    return null;
  }
  return parsePersistedPendingRemotePrecreatedWorktreeRecords(value.records, now);
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
    const rankDiff = existing
      ? recoveryPhaseRank(record.phase) - recoveryPhaseRank(existing.phase)
      : 1;
    const failureDiff = existing
      ? (record.lastFailureAt ?? 0) - (existing.lastFailureAt ?? 0)
      : 1;
    if (
      !existing
      || record.createdAt > existing.createdAt
      || (
        record.createdAt === existing.createdAt
        && (rankDiff > 0 || (rankDiff === 0 && failureDiff >= 0))
      )
    ) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RECORDS);
}

function recoveryPhaseRank(
  phase: PendingRemotePrecreatedWorktreeBase['phase'],
): number {
  if (phase === 'session-create-started') return 2;
  if (phase === 'precreated') return 1;
  return 0;
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
