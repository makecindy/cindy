import {
  parseLegacyPendingRemotePrecreatedWorktreeLedger,
  parsePrecreatedWorktreePreserveReasonFromMessage,
  type PendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktreeTarget,
  type PrecreatedWorktreePreserveReason,
  type RemotePrecreatedWorktreeFailureKind,
  type RemotePrecreatedWorktreeLedgerSnapshot,
} from '../../../shared/remotePrecreatedWorktreeLedger';
import type {
  WorktreeError,
  WorktreeMeta,
} from '@/lib/worktree.types';
import { extractIpcError } from '@/utils/ipcError';

export type {
  PendingRemotePrecreatedWorktree,
  PrecreatedWorktreePreserveReason,
  RemotePrecreatedWorktreeFailureKind,
} from '../../../shared/remotePrecreatedWorktreeLedger';

export type RemoteWorktreeInvoke = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

export interface CreateRemoteSessionWithPrecreatedWorktreeInput {
  deviceId: string;
  deviceName?: string;
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
  failureKind?: RemotePrecreatedWorktreeFailureKind;
  preserveReason?: PrecreatedWorktreePreserveReason;
}

export interface RecoverSinglePendingRemotePrecreatedWorktreeResult {
  recovered: boolean;
  failureKind?: RemotePrecreatedWorktreeFailureKind;
  preserveReason?: PrecreatedWorktreePreserveReason;
}

export interface RemoteWorktreeDiscardFailure {
  kind: RemotePrecreatedWorktreeFailureKind;
  preserveReason?: PrecreatedWorktreePreserveReason;
}

export interface RemoteWorktreeCreateRequest {
  sessionId: string;
  baseRepo: string;
  name: string;
  sourceBranch: string;
  recoveryKey: string;
}

export type ConfirmedRemoteWorktreeCreateResult =
  | { ok: true; meta: WorktreeMeta & { recoveryKey: string } }
  | { ok: false; error: WorktreeError };

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

/**
 * 本进程里 maker:create-session 已经发出、却没拿到确认就按失败收场的远程任务。
 *
 * 被控端可能在控制端放弃之后才把任务建完(高负载下 Codex 冷启动比等待预算还长)。
 * 那个任务从没交到用户手里、首条消息也没发出,用户重试又会另建一个；旧做法在下次
 * 恢复时看到任务存在就当「已认领」销账,空任务从此滞留在侧栏。
 *
 * 只记在内存里:成功路径从不登记,所以不会误删用户已经拿到的任务;进程重启后退回
 * 旧行为(只销账、不删任务)。真正删除前还要确认任务仍然完全没被用过。
 */
const abandonedSessionCreates = new Set<string>();

function abandonedSessionCreateKey(deviceId: string, sessionId: string): string {
  return `${deviceId}\u0000${sessionId}`;
}

const OFFLINE_IPC_CODES = new Set<string>([
  'DEVICE_LINK_TIMEOUT',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_UNAVAILABLE',
  'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  'DEVICE_LINK_BUSY',
  'DEVICE_LINK_STANDBY',
  'DEVICE_LINK_REMOTE_DISABLED',
  'DEVICE_LINK_ACCESS_REVOKED',
  'DEVICE_LINK_CONTROL_DISABLED',
]);

const UNSUPPORTED_IPC_CODES = new Set<string>([
  'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
  'DEVICE_LINK_VERSION_MISMATCH',
  'UNSUPPORTED_CAPABILITY',
]);

const LEGACY_CHANNEL_NOT_ALLOWED_RE =
  /(?:^|: Error: )\[CHANNEL_NOT_ALLOWED\](?:\s|$)/;

/** 标记旧预创建目录尚未安全回收，调用方据此展示本地化提示并阻止重复创建。 */
export class RemotePrecreatedWorktreeCleanupPendingError extends Error {
  readonly code = CLEANUP_PENDING_CODE;
  readonly failureKind?: RemotePrecreatedWorktreeFailureKind;
  readonly preserveReason?: PrecreatedWorktreePreserveReason;
  readonly deviceId?: string;

  constructor(options?: {
    cause?: unknown;
    failureKind?: RemotePrecreatedWorktreeFailureKind;
    preserveReason?: PrecreatedWorktreePreserveReason;
    deviceId?: string;
  }) {
    super(
      CLEANUP_PENDING_CODE,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'RemotePrecreatedWorktreeCleanupPendingError';
    this.failureKind = options?.failureKind;
    this.preserveReason = options?.preserveReason;
    this.deviceId = options?.deviceId;
  }
}

export function classifyRemoteWorktreeDiscardFailure(
  error: unknown,
): RemoteWorktreeDiscardFailure {
  if (isRemotePrecreatedWorktreeCleanupPendingError(error) && error.failureKind) {
    return {
      kind: error.failureKind,
      ...(error.preserveReason ? { preserveReason: error.preserveReason } : {}),
    };
  }
  const ipc = extractIpcError(error);
  if (ipc) {
    if (ipc.code === 'PRECONDITION_FAILED') {
      const preserveReason = parsePrecreatedWorktreePreserveReasonFromMessage(ipc.message);
      if (preserveReason === 'in-progress') {
        return { kind: 'in-progress', preserveReason };
      }
      return {
        kind: 'preserved',
        ...(preserveReason ? { preserveReason } : {}),
      };
    }
    if (ipc.code === 'PERMISSION_DENIED') {
      return { kind: 'mismatch' };
    }
    if (UNSUPPORTED_IPC_CODES.has(ipc.code)) {
      return { kind: 'unsupported' };
    }
    if (
      ipc.code === 'NOT_FOUND'
      && /no local IPC handler|Unknown channel/i.test(ipc.message)
    ) {
      return { kind: 'unsupported' };
    }
    if (OFFLINE_IPC_CODES.has(ipc.code)) {
      return { kind: 'offline' };
    }
    return { kind: 'unknown' };
  }
  if (error instanceof Error && LEGACY_CHANNEL_NOT_ALLOWED_RE.test(error.message)) {
    return { kind: 'unsupported' };
  }
  return { kind: 'offline' };
}

export function getRemoteWorktreeCleanupPendingMessage(
  failure: {
    failureKind?: RemotePrecreatedWorktreeFailureKind;
    preserveReason?: PrecreatedWorktreePreserveReason;
  },
  t: (key: string) => string,
): string {
  const { failureKind, preserveReason } = failure;
  if (failureKind === 'in-progress' || preserveReason === 'in-progress') {
    return t('ccAgent.draft.remoteWorktreeCleanup.inProgress');
  }
  if (failureKind === 'preserved') {
    switch (preserveReason) {
      case 'dirty':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedDirty');
      case 'keep-sentinel':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedKeepSentinel');
      case 'live-reference':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedLiveReference');
      case 'branch-mismatch':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedBranchMismatch');
      case 'include-files-changed':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedIncludeFilesChanged');
      case 'ignored-files':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedIgnoredFiles');
      case 'remove-failed':
      case 'quarantine-failed':
      case 'invalid-quarantine':
        return t('ccAgent.draft.remoteWorktreeCleanup.preservedRemoveFailed');
      default:
        return t('ccAgent.draft.remoteWorktreeCleanup.preserved');
    }
  }
  if (failureKind === 'mismatch') {
    return t('ccAgent.draft.remoteWorktreeCleanup.mismatch');
  }
  if (failureKind === 'unsupported') {
    return t('ccAgent.draft.remoteWorktreeCleanup.unsupported');
  }
  if (failureKind === 'create-started') {
    return t('ccAgent.draft.remoteWorktreeCleanup.createStarted');
  }
  if (failureKind === 'storage') {
    return t('ccAgent.draft.remoteWorktreeCleanup.storage');
  }
  return t('ccAgent.draft.remoteWorktreeCleanupPending');
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
    const parsed = parseLegacyPendingRemotePrecreatedWorktreeLedger(JSON.parse(raw));
    if (!parsed) return false;
    records = parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const WORKTREE_ERROR_KINDS = new Set([
  'permission-denied',
  'git-crypt-locked',
  'dubious-ownership',
  'lfs-error',
  'not-a-git-repo',
  'git-not-installed',
  'unknown',
]);

export function parseRemoteWorktreeCreateResult(
  value: unknown,
  request: RemoteWorktreeCreateRequest,
): ConfirmedRemoteWorktreeCreateResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false) {
    if (value.meta !== undefined || !isRecord(value.error)) return null;
    const error = value.error;
    if (
      typeof error.kind !== 'string'
      || !WORKTREE_ERROR_KINDS.has(error.kind)
      || typeof error.message !== 'string'
      || !error.message.trim()
      || (error.hint !== undefined && typeof error.hint !== 'string')
      || (error.rawStderr !== undefined && typeof error.rawStderr !== 'string')
    ) return null;
    return {
      ok: false,
      error: {
        kind: error.kind as WorktreeError['kind'],
        message: error.message,
        ...(typeof error.hint === 'string' ? { hint: error.hint } : {}),
        ...(typeof error.rawStderr === 'string'
          ? { rawStderr: error.rawStderr }
          : {}),
      },
    };
  }
  if (value.ok !== true || value.error !== undefined || !isRecord(value.meta)) return null;
  const meta = value.meta;
  for (const field of [
    'sessionId',
    'name',
    'path',
    'baseRepo',
    'branch',
    'sourceBranch',
    'createdAt',
  ]) {
    if (typeof meta[field] !== 'string' || !(meta[field] as string).trim()) return null;
  }
  if ((meta.sessionId as string) !== request.sessionId) return null;
  if ((meta.baseRepo as string).trim() !== request.baseRepo.trim()) return null;
  if ((meta.sourceBranch as string).trim() !== request.sourceBranch.trim()) return null;
  if (typeof meta.recoveryKey !== 'string' || meta.recoveryKey !== request.recoveryKey) return null;
  return {
    ok: true,
    meta: {
      sessionId: meta.sessionId as string,
      name: meta.name as string,
      path: meta.path as string,
      baseRepo: meta.baseRepo as string,
      branch: meta.branch as string,
      sourceBranch: meta.sourceBranch as string,
      createdAt: meta.createdAt as string,
      recoveryKey: meta.recoveryKey,
    },
  };
}

export function parseRemoteDiscardPrecreatedAck(value: unknown): {
  discarded: true;
  branchDeleted?: boolean;
} | null {
  if (!isRecord(value) || value.discarded !== true) return null;
  if (Object.keys(value).some(
    (key) => key !== 'discarded' && key !== 'branchDeleted',
  )) return null;
  if (value.branchDeleted !== undefined && typeof value.branchDeleted !== 'boolean') {
    return null;
  }
  return {
    discarded: true,
    ...(typeof value.branchDeleted === 'boolean'
      ? { branchDeleted: value.branchDeleted }
      : {}),
  };
}

export function isExplicitRemoteNotFoundError(error: unknown): boolean {
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'NOT_FOUND') {
      return true;
    }
  }
  if (!(error instanceof Error)) return false;
  return /^(?:\[NOT_FOUND\]|Error invoking remote method(?: '[^']+')?: Error: \[NOT_FOUND\])(?:\s|$)/
    .test(error.message);
}

function matchingSessionId(value: unknown, expectedId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId === expectedId ? sessionId : null;
}

/** Returns the authoritative remote session row, or null when it provably does not exist. */
async function probeClaimedSession(
  invoke: RemoteWorktreeInvoke,
  sessionId: string,
  isCurrent?: () => boolean,
): Promise<Record<string, unknown> | null> {
  try {
    assertCurrent(isCurrent);
    const value = await invoke('local-db:sessions:get', [sessionId]);
    assertCurrent(isCurrent);
    if (!isRecord(value) || value.id !== sessionId) {
      throw new RemotePrecreatedWorktreeCleanupPendingError({
        cause: new Error('Invalid remote session ownership response'),
        failureKind: 'unknown',
      });
    }
    return value;
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    if (isRemotePrecreatedWorktreeCleanupPendingError(error)) throw error;
    if (isExplicitRemoteNotFoundError(error)) return null;
    const classified = classifyRemoteWorktreeDiscardFailure(error);
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: error,
      failureKind: classified.kind,
      preserveReason: classified.preserveReason,
    });
  }
}

/**
 * 任务仍是被控端刚建好的原样:没有任何消息、没人发过、没在运行、没被置顶。
 * 字段缺失(旧被控端或异常回包)一律按「用过」处理,宁可留下也不误删。
 */
function isUntouchedRemoteSession(session: Record<string, unknown>): boolean {
  const count = session._count;
  return session.status === 'active'
    && isRecord(count)
    && count.messages === 0
    && session.userSendAt === null
    && session.activeTurnStartedAt === null
    && session.pinnedAt === null;
}

/**
 * 账本对应的任务已在被控端存在。若它是本进程放弃过的晚到创建且仍原样未动,先删掉它
 * (被控端删除流程会一并回收 worktree),再销账;删除失败时退回旧行为只销账,不能因为
 * 一个空任务挡住用户新建。
 */
async function settleClaimedRecord(
  record: PendingRemotePrecreatedWorktree,
  session: Record<string, unknown>,
  invoke: RemoteWorktreeInvoke,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const key = abandonedSessionCreateKey(record.deviceId, record.sessionId);
  if (abandonedSessionCreates.has(key) && isUntouchedRemoteSession(session)) {
    try {
      assertCurrent(isCurrent);
      await invoke('local-db:sessions:discard-unused', [record.sessionId]);
    } catch (error) {
      if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    }
  }
  abandonedSessionCreates.delete(key);
  assertCurrent(isCurrent);
  return forgetPendingRemotePrecreatedWorktree(record, isCurrent);
}

type DiscardPendingOutcome =
  | { recovered: true }
  | {
      recovered: false;
      failureKind: RemotePrecreatedWorktreeFailureKind;
      preserveReason?: PrecreatedWorktreePreserveReason;
    };

async function recordFailureDiagnostic(
  record: PendingRemotePrecreatedWorktree,
  failure: RemoteWorktreeDiscardFailure,
  isCurrent?: () => boolean,
): Promise<void> {
  const { lastFailureReason: _prevReason, ...rest } = record;
  const updated: PendingRemotePrecreatedWorktree = {
    ...rest,
    lastFailureKind: failure.kind,
    ...(failure.preserveReason ? { lastFailureReason: failure.preserveReason } : {}),
    lastFailureAt: Date.now(),
  };
  await registerPendingRemotePrecreatedWorktree(updated, isCurrent);
}

async function discardPendingRecord(
  record: PendingRemotePrecreatedWorktree,
  invoke: RemoteWorktreeInvoke,
  isCurrent?: () => boolean,
  persistDiagnostics = false,
): Promise<DiscardPendingOutcome> {
  const retain = async (
    failure: RemoteWorktreeDiscardFailure,
  ): Promise<DiscardPendingOutcome> => {
    if (persistDiagnostics) {
      await recordFailureDiagnostic(record, failure, isCurrent);
    }
    return {
      recovered: false,
      failureKind: failure.kind,
      ...(failure.preserveReason ? { preserveReason: failure.preserveReason } : {}),
    };
  };

  assertCurrent(isCurrent);
  try {
    const session = await probeClaimedSession(invoke, record.sessionId, isCurrent);
    if (session) {
      return (await settleClaimedRecord(record, session, invoke, isCurrent))
        ? { recovered: true }
        : { recovered: false, failureKind: 'storage' };
    }
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    return retain(classifyRemoteWorktreeDiscardFailure(error));
  }
  if (record.phase !== 'reserved' && record.phase !== 'precreated') {
    return retain({ kind: 'create-started' });
  }
  try {
    const locator = typeof record.recoveryKey === 'string'
      ? { sessionId: record.sessionId, recoveryKey: record.recoveryKey }
      : { sessionId: record.sessionId, path: record.path };
    assertCurrent(isCurrent);
    const discardResult = await invoke('worktree:discard-precreated', [locator]);
    assertCurrent(isCurrent);
    if (!parseRemoteDiscardPrecreatedAck(discardResult)) {
      return retain({ kind: 'unknown' });
    }
    return (await forgetPendingRemotePrecreatedWorktree(record, isCurrent))
      ? { recovered: true }
      : { recovered: false, failureKind: 'storage' };
  } catch (error) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(error)) throw error;
    // discard 与 create 共用被控端 session 锁。若拒绝来自一次已成功但丢回包的
    // create，权威 session 行会存在；dirty/keep 等其它拒绝则继续留账。
    try {
      const session = await probeClaimedSession(invoke, record.sessionId, isCurrent);
      if (session) {
        return (await settleClaimedRecord(record, session, invoke, isCurrent))
          ? { recovered: true }
          : { recovered: false, failureKind: 'storage' };
      }
    } catch (probeError) {
      if (isRemotePrecreatedWorktreeOwnerChangedError(probeError)) throw probeError;
    }
    return retain(classifyRemoteWorktreeDiscardFailure(error));
  }
}

export async function recoverSinglePendingRemotePrecreatedWorktree(input: {
  record: PendingRemotePrecreatedWorktree;
  invoke: RemoteWorktreeInvoke;
  isCurrent?: () => boolean;
}): Promise<RecoverSinglePendingRemotePrecreatedWorktreeResult> {
  const outcome = await discardPendingRecord(
    input.record,
    input.invoke,
    input.isCurrent,
    true,
  );
  if (outcome.recovered) {
    return { recovered: true };
  }
  return {
    recovered: false,
    failureKind: outcome.failureKind,
    ...(outcome.preserveReason ? { preserveReason: outcome.preserveReason } : {}),
  };
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
    const outcome = await discardPendingRecord(
      record,
      input.invoke,
      input.isCurrent,
      ledger.storageReadable,
    );
    if (outcome.recovered) {
      result.recovered += 1;
    } else {
      result.retained += 1;
      if (!result.failureKind) {
        result.failureKind = outcome.failureKind;
        if (outcome.preserveReason) {
          result.preserveReason = outcome.preserveReason;
        }
      }
    }
  }
  return result;
}

/**
 * 远程两步创建的认领事务：
 *  1. maker:create-session 前先把 cleanup obligation 持久化为 started；
 *  2. 正常回包或 exact-ID 权威 probe 命中 → 会话已认领，清账并完成；
 *  3. 一旦 createSession 开始，NOT_FOUND / 未知回包 / 超时都只保留账本，禁止
 *     retry 或 destructive discard。后续恢复仍只能由 exact-ID ownership 清账。
 */
export async function createRemoteSessionWithPrecreatedWorktree(
  input: CreateRemoteSessionWithPrecreatedWorktreeInput,
): Promise<string> {
  assertCurrent(input.isCurrent);
  const deviceName = input.deviceName?.trim() || undefined;
  const pending: PendingRemotePrecreatedWorktree = {
    deviceId: input.deviceId,
    ...(deviceName ? { deviceName } : {}),
    sessionId: input.sessionId,
    path: input.path,
    recoveryKey: input.recoveryKey,
    createdAt: input.createdAt ?? Date.now(),
    phase: 'precreated',
    ...(input.dataOwnerId ? { dataOwnerId: input.dataOwnerId } : {}),
  };
  // Main 账本在首次 worktree:create 前已经按 recoveryKey 登记；这里补齐 path。
  // 写盘失败时 Main 仍保留内存镜像，后续流程继续按 cleanup obligation 收敛。
  await registerPendingRemotePrecreatedWorktree(pending, input.isCurrent);
  assertCurrent(input.isCurrent);
  const started = { ...pending, phase: 'session-create-started' as const };
  if (!(await registerPendingRemotePrecreatedWorktree(started, input.isCurrent))) {
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      failureKind: 'storage',
      deviceId: input.deviceId,
    });
  }
  assertCurrent(input.isCurrent);

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
    await recordFailureDiagnostic(started, { kind: 'create-started' }, input.isCurrent);
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: new Error('Remote session creation returned no matching session id'),
      failureKind: 'create-started',
      deviceId: input.deviceId,
    });
  } catch (err) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(err)) throw err;
    if (isRemotePrecreatedWorktreeCleanupPendingError(err)) throw err;
  }

  // create 没拿到确认:被控端可能仍在建。先登记放弃,下次恢复若看到它晚到且原样未动就回收。
  const abandonedKey = abandonedSessionCreateKey(input.deviceId, input.sessionId);
  abandonedSessionCreates.add(abandonedKey);
  try {
    if (await probeClaimedSession(input.invoke, input.sessionId, input.isCurrent)) {
      abandonedSessionCreates.delete(abandonedKey);
      assertCurrent(input.isCurrent);
      await forgetPendingRemotePrecreatedWorktree(pending, input.isCurrent);
      return input.sessionId;
    }
  } catch (probeFailure) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(probeFailure)) throw probeFailure;
    const classified = classifyRemoteWorktreeDiscardFailure(probeFailure);
    await recordFailureDiagnostic(started, classified, input.isCurrent);
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: probeFailure,
      failureKind: classified.kind,
      preserveReason: classified.preserveReason,
      deviceId: input.deviceId,
    });
  }
  await recordFailureDiagnostic(started, { kind: 'create-started' }, input.isCurrent);
  throw new RemotePrecreatedWorktreeCleanupPendingError({
    failureKind: 'create-started',
    deviceId: input.deviceId,
  });
}

export const __testing = {
  resetAbandonedSessionCreates: (): void => abandonedSessionCreates.clear(),
  storageKey: STORAGE_KEY,
  storageOwnerKey: STORAGE_OWNER_KEY,
  setLedgerApi: (api: RemotePrecreatedWorktreeLedgerApi | null): void => {
    ledgerApiOverride = api;
  },
};

export interface PrecreateRemoteDraftWorktreeInput {
  deviceId: string;
  deviceName?: string;
  /** Preset id shared by worktree:create and maker:create-session (close-session reclaims by it). */
  sessionId: string;
  /** Owner captured at send; the cleanup ledger is bound to it. */
  dataOwnerId: string | null | undefined;
  baseRepo: string;
  /** Name typed by the user; empty → an automatic one. */
  name: string;
  sourceBranch: string;
  /** This computer names the worktree; the remote receives an ordinary explicit name. */
  resolveName: (name: string) => Promise<string>;
  makeRecoveryKey: () => string;
  invoke: RemoteWorktreeInvoke;
  isCurrent: () => boolean;
  /** Creating overlay: shown with the provisional name, renamed once named, cleared at the end. */
  progress: { start: (name: string) => void; named: (name: string) => void; end: () => void };
}

export type PrecreateRemoteDraftWorktreeResult =
  | { ok: true; path: string; recoveryKey: string; createdAt: number }
  | { ok: false; error: WorktreeError };

/**
 * 远程新建任务的 worktree 预创建(两步创建的第一步)：先恢复同设备遗留的清理义务，
 * 在远端副作用前持久化 recoveryKey，再请被控端检出。内置引擎与插件引擎的新建共用这一段
 * (2026-11-25 用户要求插件引擎在所有地方与内置引擎一样能用 worktree)。
 *
 * - 被控端明确拒绝(`ok: false`)：账本已撤销，调用方提示错误并恢复草稿。
 * - 回包缺失或抛错：无法判断被控端是否已建好，保留账本并抛 CleanupPending，交给重连/重启恢复。
 * - 账号在等待中变化：抛 OwnerChanged，调用方静默放弃。
 */
export async function precreateRemoteDraftWorktree(
  input: PrecreateRemoteDraftWorktreeInput,
): Promise<PrecreateRemoteDraftWorktreeResult> {
  const { deviceId, dataOwnerId, invoke, isCurrent } = input;
  const deviceName = input.deviceName?.trim() || undefined;
  // 账本必须绑定发起时的账号/本地数据 owner；没有 owner 无法承担清理义务。
  if (!dataOwnerId) {
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      failureKind: 'storage',
      deviceId,
    });
  }
  // 上次两步创建若断线失败，本地账本仍承担 cleanup obligation：新建下一份前先恢复，
  // 无法确认回收/认领时硬挡本次 worktree:create，避免每次重试生成一个新的受管目录。
  const recovery = await recoverPendingRemotePrecreatedWorktrees({ deviceId, dataOwnerId, invoke, isCurrent });
  assertCurrent(isCurrent);
  // 账本不可读时磁盘上是否还有旧 obligation 未知，同样 fail closed。
  if (!recovery.storageReadable || recovery.retained > 0) {
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      failureKind: recovery.storageReadable ? recovery.failureKind : 'storage',
      preserveReason: recovery.preserveReason,
      deviceId,
    });
  }
  let name = input.name.trim();
  if (!name) name = `auto-${Date.now().toString(36).slice(-6)}`;
  const recoveryKey = input.makeRecoveryKey();
  const createdAt = Date.now();
  const reservation: PendingRemotePrecreatedWorktree = {
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    sessionId: input.sessionId,
    dataOwnerId,
    recoveryKey,
    createdAt,
    phase: 'reserved',
  };
  // 远端副作用之前先持久化 reservation。首次写盘失败时绝不调用 worktree:create。
  assertCurrent(isCurrent);
  const reservationRecorded = await registerPendingRemotePrecreatedWorktree(reservation, isCurrent);
  assertCurrent(isCurrent);
  if (!reservationRecorded) {
    await forgetPendingRemotePrecreatedWorktree(reservation, isCurrent);
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      failureKind: 'storage',
      deviceId,
    });
  }
  input.progress.start(name);
  try {
    name = await input.resolveName(name);
    assertCurrent(isCurrent);
    input.progress.named(name);
    const createRequest: RemoteWorktreeCreateRequest = {
      sessionId: input.sessionId,
      baseRepo: input.baseRepo,
      name,
      sourceBranch: input.sourceBranch.trim() || 'HEAD',
      recoveryKey,
    };
    const resp = parseRemoteWorktreeCreateResult(await invoke('worktree:create', [createRequest]), createRequest);
    if (!resp) {
      await recordFailureDiagnostic(reservation, { kind: 'unknown' }, isCurrent);
      throw new RemotePrecreatedWorktreeCleanupPendingError({
        failureKind: 'unknown',
        deviceId,
      });
    }
    if (!resp.ok) {
      assertCurrent(isCurrent);
      await forgetPendingRemotePrecreatedWorktree(reservation, isCurrent);
      assertCurrent(isCurrent);
      return { ok: false, error: resp.error };
    }
    // 回包后尽力补 path；即使更新失败，已落盘的 recoveryKey reservation 仍足够精确恢复。
    assertCurrent(isCurrent);
    await registerPendingRemotePrecreatedWorktree(
      { ...reservation, path: resp.meta.path, phase: 'precreated' },
      isCurrent,
    );
    assertCurrent(isCurrent);
    return { ok: true, path: resp.meta.path, recoveryKey, createdAt };
  } catch (err) {
    if (isRemotePrecreatedWorktreeOwnerChangedError(err)) throw err;
    if (isRemotePrecreatedWorktreeCleanupPendingError(err)) throw err;
    // invoke 抛错时无法判断被控端是否已完成创建：保留 reservation，交给重连/重启恢复，
    // 不能把「不知道」展示成普通创建失败后允许重试。
    const classified = classifyRemoteWorktreeDiscardFailure(err);
    await recordFailureDiagnostic(reservation, classified, isCurrent);
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: err,
      failureKind: classified.kind,
      preserveReason: classified.preserveReason,
      deviceId,
    });
  } finally {
    input.progress.end();
  }
}
