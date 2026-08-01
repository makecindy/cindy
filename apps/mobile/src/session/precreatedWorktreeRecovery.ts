import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isPreconditionFailedRemoteError,
  withTransientRemoteRetry,
} from '@cindy/maker-shared/device-link-contract';

/**
 * 移动端两步建会话的恢复账本。
 *
 * 手机在 worktree:create 前先把 sessionId + recoveryKey 持久化；即使进程在 create
 * 回包前被系统杀掉，重启后也能让被控端按该随机键解析真实路径并安全回收。拿到
 * create 回包后再补写 path，兼容旧的 path-only 记录。账本不保存草稿、消息、凭证
 * 或 worktree 内容，并按账号隔离，避免换账号误碰旧设备。
 */

const STORAGE_KEY_PREFIX = 'xdt.mobile.precreated-worktree-recovery.v1.';
const STORAGE_VERSION = 1;
const MAX_RECORDS = 32;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MIN_RECOVERY_KEY_LENGTH = 16;
const MAX_RECOVERY_KEY_LENGTH = 256;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

interface PendingPrecreatedWorktreeBase {
  sessionId: string;
  deviceId: string;
  createdAt: number;
}

export type PendingPrecreatedWorktree = PendingPrecreatedWorktreeBase & (
  | {
      /** create 回包后可用；旧账本只有该定位符。 */
      path: string;
      recoveryKey?: string;
    }
  | {
      path?: never;
      /** create 前持久化的新定位符。 */
      recoveryKey: string;
    }
);

interface StoredRecoveryLedger {
  version: typeof STORAGE_VERSION;
  records: PendingPrecreatedWorktree[];
}

export interface PrecreatedWorktreeRecoveryDeps {
  openLink: (deviceId: string) => Promise<unknown>;
  discardPrecreated: (
    deviceId: string,
    input:
      | { sessionId: string; path: string; recoveryKey?: never }
      | { sessionId: string; recoveryKey: string; path?: never },
  ) => Promise<unknown>;
  /**
   * PRECONDITION_FAILED 既可能表示会话已经认领 worktree，也可能表示
   * worktree 有改动/保留标记。调用方用权威 get-session 区分二者，只有前者
   * 才能从账本移除。
   */
  isSessionClaimed: (deviceId: string, sessionId: string) => Promise<boolean>;
  /** 测试注入；生产使用 withTransientRemoteRetry 的默认退避。 */
  sleep?: (ms: number) => Promise<void>;
  /** 任务仍在当前进程内时延后，避免恢复 bridge 与创建管线竞态。 */
  shouldDefer?: (record: PendingPrecreatedWorktree) => boolean;
  /**
   * 账号 owner generation fence。账号切换后旧 run 必须在下一次远程 ownership
   * probe / discard 前停止；否则稳定的 Device Link callback 可能取到新账号的
   * client，对旧账号的 recoveryKey 执行 destructive discard。
   */
  isCurrent?: () => boolean;
}

export interface PrecreatedWorktreeRecoveryResult {
  attempted: number;
  recovered: number;
  deferred: number;
  retained: number;
  storageReadable: boolean;
}

let mutationQueue: Promise<void> = Promise.resolve();
const registrationInFlight = new Map<string, number>();
// AsyncStorage 写失败时仍保留当前进程的 cleanup obligation。它不是跨进程
// 持久化替代品；作用是让本进程重连恢复、并阻止下一次创建继续制造孤儿。
const volatileLedgers = new Map<string, PendingPrecreatedWorktree[]>();

function markRegistrationInFlight(sessionId: string): void {
  registrationInFlight.set(
    sessionId,
    (registrationInFlight.get(sessionId) ?? 0) + 1,
  );
}

function unmarkRegistrationInFlight(sessionId: string): void {
  const count = registrationInFlight.get(sessionId) ?? 0;
  if (count <= 1) {
    registrationInFlight.delete(sessionId);
  } else {
    registrationInFlight.set(sessionId, count - 1);
  }
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeAccountId(accountId: string): string {
  return typeof accountId === 'string' ? accountId.trim() : '';
}

function storageKeyForAccount(accountId: string): string | null {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) return null;
  // 不把完整账号标识直接作为 key；保留可读前缀便于诊断，同时用 hash
  // 防止含特殊字符的账号破坏 AsyncStorage key 约定。
  return `${STORAGE_KEY_PREFIX}${sanitizeSegment(normalized)}.${fnv1a(normalized)}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'account';
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function volatileRecordsForAccount(
  accountId: string,
): PendingPrecreatedWorktree[] {
  const key = storageKeyForAccount(accountId);
  return key ? (volatileLedgers.get(key) ?? []) : [];
}

function replaceVolatileRecords(
  accountId: string,
  records: readonly PendingPrecreatedWorktree[],
): void {
  const key = storageKeyForAccount(accountId);
  if (!key) return;
  const normalized = normalizeRecords(records);
  if (normalized.length === 0) {
    volatileLedgers.delete(key);
  } else {
    volatileLedgers.set(key, normalized);
  }
}

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

function coerceRecord(
  value: unknown,
  now: number,
): PendingPrecreatedWorktree | null {
  if (!isRecord(value)) return null;
  const sessionId = readString(value.sessionId, MAX_SESSION_ID_LENGTH);
  const deviceId = readString(value.deviceId, MAX_DEVICE_ID_LENGTH);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const recoveryKey = readRecoveryKey(value.recoveryKey);
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  if (!sessionId || !deviceId || (!path && !recoveryKey) || createdAt <= 0) return null;
  if (createdAt > now + 5 * 60 * 1000) return null;
  if (now - createdAt > MAX_RECORD_AGE_MS) return null;
  const base = {
    sessionId,
    deviceId,
    createdAt,
  };
  if (path) {
    return {
      ...base,
      path,
      ...(recoveryKey ? { recoveryKey } : {}),
    };
  }
  if (!recoveryKey) return null;
  return {
    ...base,
    recoveryKey,
  };
}

function normalizeRecords(
  value: unknown,
  now = Date.now(),
): PendingPrecreatedWorktree[] {
  const rawRecords =
    isRecord(value) && Array.isArray(value.records)
      ? value.records
      : Array.isArray(value)
        ? value
        : [];
  const bySession = new Map<string, PendingPrecreatedWorktree>();
  for (const raw of rawRecords) {
    const record = coerceRecord(raw, now);
    if (!record) continue;
    const existing = bySession.get(record.sessionId);
    if (!existing || record.createdAt >= existing.createdAt) {
      bySession.set(record.sessionId, record);
    }
  }
  return [...bySession.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RECORDS);
}

async function readRecordsUnserialized(
  accountId: string,
  now = Date.now(),
): Promise<{
  records: PendingPrecreatedWorktree[];
  storageReadable: boolean;
}> {
  const key = storageKeyForAccount(accountId);
  if (!key) return { records: [], storageReadable: false };
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    return {
      records: normalizeRecords(volatileRecordsForAccount(accountId), now),
      storageReadable: false,
    };
  }
  let persisted: PendingPrecreatedWorktree[] = [];
  if (raw) {
    try {
      persisted = normalizeRecords(JSON.parse(raw), now);
    } catch {
      // 损坏的账本可能仍代表未完成的回收义务。不能删除后当空账本继续创建，
      // 保留原值并让调用方按不可读状态 fail closed。
      return {
        records: normalizeRecords(volatileRecordsForAccount(accountId), now),
        storageReadable: false,
      };
    }
  }
  return {
    records: normalizeRecords(
      [...volatileRecordsForAccount(accountId), ...persisted],
      now,
    ),
    storageReadable: true,
  };
}

async function writeRecordsUnserialized(
  accountId: string,
  records: readonly PendingPrecreatedWorktree[],
): Promise<boolean> {
  const key = storageKeyForAccount(accountId);
  if (!key) return false;
  try {
    if (records.length === 0) {
      await AsyncStorage.removeItem(key);
    } else {
      const payload: StoredRecoveryLedger = {
        version: STORAGE_VERSION,
        records: normalizeRecords(records),
      };
      await AsyncStorage.setItem(key, JSON.stringify(payload));
    }
    return true;
  } catch {
    return false;
  }
}

export async function listPendingPrecreatedWorktrees(
  accountId: string,
): Promise<PendingPrecreatedWorktree[]> {
  const { records } = await readPendingPrecreatedWorktreeLedger(accountId);
  return records;
}

async function readPendingPrecreatedWorktreeLedger(
  accountId: string,
): Promise<{
  records: PendingPrecreatedWorktree[];
  storageReadable: boolean;
}> {
  return enqueueMutation(async () => {
    const {
      records: normalized,
      storageReadable,
    } = await readRecordsUnserialized(accountId);
    replaceVolatileRecords(accountId, normalized);
    // 读侧顺手清理可解析的过期/无效条目，并把上次因写盘失败只留在内存的
    // 记录重新持久化；读取或解析失败时绝不以“空账本”覆盖未知的磁盘真值。
    if (storageReadable) {
      await writeRecordsUnserialized(accountId, normalized);
    }
    return { records: normalized, storageReadable };
  });
}

export async function registerPendingPrecreatedWorktree(
  accountId: string,
  record: PendingPrecreatedWorktree,
): Promise<boolean> {
  const normalized = coerceRecord(record, Date.now());
  if (!storageKeyForAccount(accountId) || !normalized) return false;
  // 必须先于任何 await 写内存镜像：即使 AsyncStorage.setItem 与紧随其后的
  // discard 同时失败，本进程仍能在重连 / 下次发送时找到这份 obligation。
  replaceVolatileRecords(accountId, [
    normalized,
    ...volatileRecordsForAccount(accountId).filter(
      (item) => item.sessionId !== normalized.sessionId,
    ),
  ]);
  markRegistrationInFlight(normalized.sessionId);
  try {
    return await enqueueMutation(async () => {
      const {
        records: current,
        storageReadable,
      } = await readRecordsUnserialized(accountId);
      const next = [
        normalized,
        ...current.filter((item) => item.sessionId !== normalized.sessionId),
      ].slice(0, MAX_RECORDS);
      replaceVolatileRecords(accountId, next);
      if (!storageReadable) return false;
      return writeRecordsUnserialized(accountId, next);
    });
  } finally {
    unmarkRegistrationInFlight(normalized.sessionId);
  }
}

/**
 * Keep the recovery bridge out of the handoff gap between persisting the ledger
 * and registering the in-memory creation task. The caller owns the returned
 * release function and must call it once the task is registered or abandoned.
 */
export function holdPrecreatedWorktreeRegistration(sessionId: string): () => void {
  const normalized = sessionId.trim();
  if (!normalized) return () => undefined;
  markRegistrationInFlight(normalized);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unmarkRegistrationInFlight(normalized);
  };
}

export function isPrecreatedWorktreeRegistrationInFlight(
  sessionId: string,
): boolean {
  return registrationInFlight.has(sessionId);
}

export async function forgetPendingPrecreatedWorktree(
  accountId: string,
  target: Pick<PendingPrecreatedWorktree, 'sessionId'> & {
    path?: string;
    recoveryKey?: string;
    createdAt?: number;
  },
): Promise<void> {
  await enqueueMutation(async () => {
    const {
      records: current,
      storageReadable,
    } = await readRecordsUnserialized(accountId);
    const next = current.filter(
      (item) => {
        if (item.sessionId !== target.sessionId) return true;
        const locatorMatches = target.recoveryKey !== undefined
          ? item.recoveryKey === target.recoveryKey
          : target.path !== undefined && item.path === target.path;
        if (!locatorMatches) return true;
        return target.createdAt !== undefined && item.createdAt !== target.createdAt;
      },
    );
    replaceVolatileRecords(accountId, next);
    if (storageReadable && next.length !== current.length) {
      await writeRecordsUnserialized(accountId, next);
    }
  });
}

function errorCode(error: unknown): string {
  const code =
    isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return `${code} ${message}`.toUpperCase();
}

function isNonRetryableLocatorFailure(error: unknown): boolean {
  const text = errorCode(error);
  return (
    text.includes('PERMISSION_DENIED') ||
    text.includes('INVALID_PARAMS')
  );
}

async function removeIfCurrent(
  accountId: string,
  record: PendingPrecreatedWorktree,
): Promise<void> {
  await forgetPendingPrecreatedWorktree(accountId, record);
}

function isRecoveryCurrent(deps: PrecreatedWorktreeRecoveryDeps): boolean {
  return deps.isCurrent?.() ?? true;
}

/**
 * 冷启动 / 重连时主动处理没有当前内存 task 认领的记录。
 *
 * 处理策略是保守的：成功回收或确认 session 已认领才删账；网络失败、设备不可用、
 * worktree 有改动/保留标记，以及老被控端缺少精确回收 channel 都留账，下一次
 * 链路恢复或被控端升级后继续尝试。
 */
export async function recoverPendingPrecreatedWorktrees(
  accountId: string,
  deps: PrecreatedWorktreeRecoveryDeps,
): Promise<PrecreatedWorktreeRecoveryResult> {
  const ledger = await readPendingPrecreatedWorktreeLedger(accountId);
  const records = ledger.records;
  const result: PrecreatedWorktreeRecoveryResult = {
    attempted: 0,
    recovered: 0,
    deferred: 0,
    retained: 0,
    storageReadable: ledger.storageReadable,
  };
  for (const record of records) {
    if (!isRecoveryCurrent(deps)) break;
    if (deps.shouldDefer?.(record)) {
      result.deferred += 1;
      continue;
    }
    result.attempted += 1;
    try {
      await withTransientRemoteRetry(
        async () => {
          // Check immediately before every remote operation. The recovery bridge's
          // openLink/invoke callbacks are stable and resolve the current client at
          // call time, so an owner switch can otherwise retarget this old run.
          if (!isRecoveryCurrent(deps)) return;
          await deps.openLink(record.deviceId);
          if (!isRecoveryCurrent(deps)) return;
          if (await deps.isSessionClaimed(record.deviceId, record.sessionId)) {
            return;
          }
          if (!isRecoveryCurrent(deps)) return;
          if (typeof record.path === 'string') {
            await deps.discardPrecreated(record.deviceId, {
              sessionId: record.sessionId,
              path: record.path,
            });
          } else if (typeof record.recoveryKey === 'string') {
            await deps.discardPrecreated(record.deviceId, {
              sessionId: record.sessionId,
              recoveryKey: record.recoveryKey,
            });
          } else {
            throw new Error('Invalid pre-created worktree recovery record');
          }
        },
        {
          maxAttempts: 2,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
      );
      if (!isRecoveryCurrent(deps)) break;
      await removeIfCurrent(accountId, record);
      result.recovered += 1;
      continue;
    } catch (error) {
      // Do not let the old owner's catch path perform a second ownership probe or
      // remove the old ledger after the auth owner has changed.
      if (!isRecoveryCurrent(deps)) break;
      // 旧工作端可能已经成功创建 session，但不认识新的 discard channel。无论
      // discard 以何种错误返回都再对账一次，不能只在 PRECONDITION_FAILED 时查询。
      try {
        if (!isRecoveryCurrent(deps)) break;
        if (await deps.isSessionClaimed(record.deviceId, record.sessionId)) {
          if (!isRecoveryCurrent(deps)) break;
          await removeIfCurrent(accountId, record);
          result.recovered += 1;
          continue;
        }
      } catch {
        // 无法确认 ownership 时按原错误分类；未知状态仍保留账本。
      }
      if (isPreconditionFailedRemoteError(error)) {
        result.retained += 1;
        continue;
      }
      if (isNonRetryableLocatorFailure(error)) {
        // 已确认的定位符不匹配不应永久制造无效重试。CHANNEL_NOT_ALLOWED
        // 不属于该类：旧端启动期对账已经错过时，只有保留义务才能等升级后回收。
        await removeIfCurrent(accountId, record);
        result.recovered += 1;
        continue;
      }
      result.retained += 1;
    }
  }
  return result;
}

export const __testing = {
  storageKeyForAccount,
  normalizeRecords,
  coerceRecord,
  drainMutations: () => mutationQueue,
  resetVolatileLedgers: () => volatileLedgers.clear(),
};
