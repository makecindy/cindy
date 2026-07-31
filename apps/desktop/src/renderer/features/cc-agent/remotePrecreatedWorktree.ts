import {
  normalizePendingRemotePrecreatedWorktrees,
  type PendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktreeTarget,
  type RemotePrecreatedWorktreeLedgerSnapshot,
} from '../../../shared/remotePrecreatedWorktreeLedger';

export type { PendingRemotePrecreatedWorktree } from '../../../shared/remotePrecreatedWorktreeLedger';

export type RemoteWorktreeInvoke = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

export interface CreateRemoteSessionWithPrecreatedWorktreeInput {
  deviceId: string;
  sessionId: string;
  path: string;
  recoveryKey: string;
  /** Owner captured when the remote worktree operation started. */
  dataOwnerId?: string;
  createdAt?: number;
  createArgs: unknown;
  invoke: RemoteWorktreeInvoke;
  isCurrent?: () => boolean;
}

export interface RecoverPendingRemotePrecreatedWorktreesInput {
  deviceId: string;
  /** Owner whose obligations may be reconciled; prevents account-switch bleed. */
  dataOwnerId?: string;
  invoke: RemoteWorktreeInvoke;
  isCurrent?: () => boolean;
}

export interface RecoverPendingRemotePrecreatedWorktreesResult {
  attempted: number;
  recovered: number;
  retained: number;
  storageReadable: boolean;
}

const STORAGE_KEY = 'xdt.desktop.remote-precreated-worktree-recovery.v1';
const STORAGE_OWNER_KEY = `${STORAGE_KEY}.owner`;
const CLEANUP_PENDING_CODE = 'REMOTE_PRECREATED_WORKTREE_CLEANUP_PENDING';
const OWNER_CHANGED_CODE = 'REMOTE_PRECREATED_WORKTREE_OWNER_CHANGED';

interface RemotePrecreatedWorktreeLedgerApi {
  list(): Promise<RemotePrecreatedWorktreeLedgerSnapshot>;
  register(
    record: PendingRemotePrecreatedWorktree,
  ): Promise<{ persisted: boolean }>;
  forget(
    target: PendingRemotePrecreatedWorktreeTarget,
  ): Promise<{ persisted: boolean }>;
}

let ledgerApiOverride: RemotePrecreatedWorktreeLedgerApi | null = null;

/** 标记旧预创建目录尚未安全回收，调用方据此展示本地化提示并阻止重复创建。 */
export class RemotePrecreatedWorktreeCleanupPendingError extends Error {
  readonly code = CLEANUP_PENDING_CODE;

  constructor(options?: { cause?: unknown }) {
    super(CLEANUP_PENDING_CODE, options);
    this.name = 'RemotePrecreatedWorktreeCleanupPendingError';
  }
}

export function isRemotePrecreatedWorktreeCleanupPendingError(
  error: unknown,
): error is RemotePrecreatedWorktreeCleanupPendingError {
  return (
    error instanceof RemotePrecreatedWorktreeCleanupPendingError
    || (
      !!error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === CLEANUP_PENDING_CODE
    )
  );
}

/** The auth/data owner changed while a remote two-step create was in flight. */
export class RemotePrecreatedWorktreeOwnerChangedError extends Error {
  readonly code = OWNER_CHANGED_CODE;

  constructor() {
    super(OWNER_CHANGED_CODE);
    this.name = 'RemotePrecreatedWorktreeOwnerChangedError';
  }
}

export function isRemotePrecreatedWorktreeOwnerChangedError(
  error: unknown,
): error is RemotePrecreatedWorktreeOwnerChangedError {
  return (
    error instanceof RemotePrecreatedWorktreeOwnerChangedError
    || (
      !!error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === OWNER_CHANGED_CODE
    )
  );
}

function assertCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) {
    throw new RemotePrecreatedWorktreeOwnerChangedError();
  }
}

function getLedgerApi(): RemotePrecreatedWorktreeLedgerApi {
  return ledgerApiOverride ?? window.electronAPI.remotePrecreatedWorktreeLedger;
}

/**
 * 旧版本 Renderer localStorage → Main electron-store 一次性迁移。
 *
 * 每条都由 Main 原子 register；全部确认持久化后才删旧 key。多窗口同时迁移只会
 * 幂等覆盖同一 device/session 记录，不会再产生整表 last-writer-wins。
 */
async function migrateLegacyLedger(
  dataOwnerId?: string,
  isCurrent?: () => boolean,
): Promise<boolean> {
  assertCurrent(isCurrent);
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return true;

  let records: PendingRemotePrecreatedWorktree[];
  try {
    records = normalizePendingRemotePrecreatedWorktrees(JSON.parse(raw));
  } catch {
    // 未知旧真值不能按空账本覆盖；保留 key 并让创建 fail closed。
    return false;
  }
  if (records.length === 0) {
    try {
      assertCurrent(isCurrent);
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_OWNER_KEY);
      return true;
    } catch (error) {
      if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
      return false;
    }
  }
  if (!dataOwnerId) {
    return false;
  }

  try {
    assertCurrent(isCurrent);
    const storedOwner = localStorage.getItem(STORAGE_OWNER_KEY)?.trim() || null;
    if (storedOwner && storedOwner !== dataOwnerId) {
      // The legacy key was first observed under another owner. Keep it
      // quarantined until that owner can complete the migration; otherwise an
      // account switch would attach old path-only records to the wrong user.
      return false;
    }
    if (
      records.some(
        (record) => record.dataOwnerId !== undefined && record.dataOwnerId !== dataOwnerId,
      )
    ) {
      return false;
    }
    if (!storedOwner) {
      // Bind the one-time migration before registering any record. A failed
      // write leaves the marker behind, so a later account cannot claim it.
      localStorage.setItem(STORAGE_OWNER_KEY, dataOwnerId);
    }
    for (const record of records) {
      assertCurrent(isCurrent);
      const result = await getLedgerApi().register({
        ...record,
        dataOwnerId,
      });
      assertCurrent(isCurrent);
      if (!result.persisted) return false;
    }
    assertCurrent(isCurrent);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_OWNER_KEY);
    return true;
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    return false;
  }
}

export async function listPendingRemotePrecreatedWorktrees(
  dataOwnerId?: string,
): Promise<
  PendingRemotePrecreatedWorktree[]
> {
  return (await readPendingRemotePrecreatedWorktreeLedger(dataOwnerId)).records;
}

async function readPendingRemotePrecreatedWorktreeLedger(
  dataOwnerId?: string,
): Promise<
  RemotePrecreatedWorktreeLedgerSnapshot
> {
  const legacyMigrated = await migrateLegacyLedger(dataOwnerId);
  try {
    const snapshot = await getLedgerApi().list();
    return {
      records: snapshot.records.filter(
        (record) => !dataOwnerId || record.dataOwnerId === dataOwnerId,
      ),
      storageReadable: legacyMigrated && snapshot.storageReadable,
    };
  } catch {
    return { records: [], storageReadable: false };
  }
}

export async function registerPendingRemotePrecreatedWorktree(
  record: PendingRemotePrecreatedWorktree,
  isCurrent?: () => boolean,
): Promise<boolean> {
  assertCurrent(isCurrent);
  if (!(await migrateLegacyLedger(record.dataOwnerId, isCurrent))) return false;
  try {
    assertCurrent(isCurrent);
    const result = await getLedgerApi().register(record);
    assertCurrent(isCurrent);
    return result.persisted;
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    return false;
  }
}

export async function forgetPendingRemotePrecreatedWorktree(
  target: PendingRemotePrecreatedWorktreeTarget,
  isCurrent?: () => boolean,
): Promise<boolean> {
  try {
    assertCurrent(isCurrent);
    const result = await getLedgerApi().forget(target);
    assertCurrent(isCurrent);
    return result.persisted;
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    return false;
  }
}

function matchingSessionId(value: unknown, expectedId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId === expectedId ? sessionId : null;
}

async function probeClaimedSession(
  invoke: RemoteWorktreeInvoke,
  sessionId: string,
  isCurrent?: () => boolean,
): Promise<boolean> {
  try {
    assertCurrent(isCurrent);
    const value = await invoke('local-db:sessions:get', [sessionId]);
    assertCurrent(isCurrent);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as { id?: unknown }).id === sessionId;
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    return false;
  }
}

async function discardPendingRecord(
  record: PendingRemotePrecreatedWorktree,
  invoke: RemoteWorktreeInvoke,
  isCurrent?: () => boolean,
): Promise<boolean> {
  assertCurrent(isCurrent);
  if (await probeClaimedSession(invoke, record.sessionId, isCurrent)) {
    assertCurrent(isCurrent);
    return forgetPendingRemotePrecreatedWorktree(record, isCurrent);
  }
  try {
    const locator = typeof record.path === 'string'
      ? { sessionId: record.sessionId, path: record.path }
      : { sessionId: record.sessionId, recoveryKey: record.recoveryKey };
    assertCurrent(isCurrent);
    await invoke('worktree:discard-precreated', [locator]);
    assertCurrent(isCurrent);
    return forgetPendingRemotePrecreatedWorktree(record, isCurrent);
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    // discard 与 create 共用被控端 session 锁。若拒绝来自一次已成功但丢回包的
    // create，权威 session 行会存在；dirty/keep 等其它拒绝则继续留账。
    if (await probeClaimedSession(invoke, record.sessionId, isCurrent)) {
      assertCurrent(isCurrent);
      return forgetPendingRemotePrecreatedWorktree(record, isCurrent);
    }
    return false;
  }
}

/**
 * 新一次远程 worktree:create 前恢复同设备旧 obligation。只有成功回收或确认
 * session 已认领才删账；隧道仍不可用、worktree dirty/keep 等情况继续留账，
 * 调用方必须阻止创建第二份 worktree。
 */
export async function recoverPendingRemotePrecreatedWorktrees(
  input: RecoverPendingRemotePrecreatedWorktreesInput,
): Promise<RecoverPendingRemotePrecreatedWorktreesResult> {
  assertCurrent(input.isCurrent);
  const legacyMigrated = await migrateLegacyLedger(input.dataOwnerId, input.isCurrent);
  assertCurrent(input.isCurrent);
  let ledger: RemotePrecreatedWorktreeLedgerSnapshot;
  try {
    const snapshot = await getLedgerApi().list();
    assertCurrent(input.isCurrent);
    ledger = {
      records: snapshot.records.filter(
        (record) =>
          (!input.dataOwnerId || record.dataOwnerId === input.dataOwnerId),
      ),
      storageReadable: legacyMigrated && snapshot.storageReadable,
    };
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    ledger = { records: [], storageReadable: false };
  }
  const records = ledger.records.filter(
    (record) =>
      record.deviceId === input.deviceId
      && (!input.dataOwnerId || record.dataOwnerId === input.dataOwnerId),
  );
  const result: RecoverPendingRemotePrecreatedWorktreesResult = {
    attempted: 0,
    recovered: 0,
    retained: 0,
    storageReadable: ledger.storageReadable,
  };
  for (const record of records) {
    assertCurrent(input.isCurrent);
    result.attempted += 1;
    if (await discardPendingRecord(record, input.invoke, input.isCurrent)) {
      result.recovered += 1;
    } else {
      result.retained += 1;
    }
  }
  return result;
}

/**
 * 远程两步创建的补偿事务：
 *  1. maker:create-session 前先登记本地 cleanup obligation；
 *  2. 正常回包或权威 probe 命中 → 会话已认领，清账并完成；
 *  3. 未确认落库才请求精确 discard。被控端会与 create 共用 session 锁并再次
 *     核对 DB/live ownership，因此超时后晚到的成功 create 不会被误删；
 *  4. discard 若因会话已认领而拒绝，再 probe 一次后按成功收敛；
 *  5. discard / probe 都失败时保留账本，让下次发送先恢复，不能生成第二份。
 */
export async function createRemoteSessionWithPrecreatedWorktree(
  input: CreateRemoteSessionWithPrecreatedWorktreeInput,
): Promise<string> {
  assertCurrent(input.isCurrent);
  const pending: PendingRemotePrecreatedWorktree = {
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    path: input.path,
    recoveryKey: input.recoveryKey,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.dataOwnerId ? { dataOwnerId: input.dataOwnerId } : {}),
  };
  // Main 账本在首次 worktree:create 前已经按 recoveryKey 登记；这里补齐 path。
  // 写盘失败时 Main 仍保留内存镜像，后续流程继续按 cleanup obligation 收敛。
  await registerPendingRemotePrecreatedWorktree(pending, input.isCurrent);
  assertCurrent(input.isCurrent);

  let createFailure: unknown;
  try {
    assertCurrent(input.isCurrent);
    const result = await input.invoke('maker:create-session', [input.createArgs]);
    assertCurrent(input.isCurrent);
    const sessionId = matchingSessionId(result, input.sessionId);
    if (sessionId) {
      assertCurrent(input.isCurrent);
      await forgetPendingRemotePrecreatedWorktree(pending, input.isCurrent);
      return sessionId;
    }
    createFailure = new Error('Remote session creation returned no matching session id');
  } catch (err) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(err)) throw err;
    createFailure = err;
  }

  if (await probeClaimedSession(input.invoke, input.sessionId, input.isCurrent)) {
    assertCurrent(input.isCurrent);
    await forgetPendingRemotePrecreatedWorktree(pending, input.isCurrent);
    return input.sessionId;
  }

  try {
    assertCurrent(input.isCurrent);
    await input.invoke('worktree:discard-precreated', [{
      sessionId: input.sessionId,
      path: input.path,
    }]);
    assertCurrent(input.isCurrent);
    await forgetPendingRemotePrecreatedWorktree(pending, input.isCurrent);
  } catch (cleanupFailure) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(cleanupFailure)) throw cleanupFailure;
    if (await probeClaimedSession(input.invoke, input.sessionId, input.isCurrent)) {
      assertCurrent(input.isCurrent);
      await forgetPendingRemotePrecreatedWorktree(pending, input.isCurrent);
      return input.sessionId;
    }
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: cleanupFailure,
    });
  }

  throw createFailure;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  storageOwnerKey: STORAGE_OWNER_KEY,
  setLedgerApi: (api: RemotePrecreatedWorktreeLedgerApi | null): void => {
    ledgerApiOverride = api;
  },
};
