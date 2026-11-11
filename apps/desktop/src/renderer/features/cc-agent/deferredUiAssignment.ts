import { makerApiForDevice } from '@/lib/makerTransport';

type EnableOrcaOptions = Parameters<typeof window.electronAPI.maker.enableOrca>[1];

export interface DeferredUiAssignment {
  workerSessionId: string;
  initialTask: string;
  /** Worker 创建完成、Lead 首条输入开始之前的本地时间。 */
  snapshotBeforeMs: number;
  /** 非空时经 device-link 派给被控端 Worker；缺省走本机 maker。 */
  deviceId?: string;
}

const STORAGE_KEY = 'xdt:deferredUiAssignment:v1';
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let activeDataOwnerId: string | null = null;
const dispatchesInFlight = new Map<string, Promise<void>>();
const consumedAssignments = new Set<string>();

interface StoredAssignment {
  assignment: DeferredUiAssignment;
  state: 'pending' | 'uncertain';
  createdAt: number;
}

function storageKey(): string {
  return activeDataOwnerId
    ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}`
    : STORAGE_KEY;
}

function assignmentKey(leadSessionId: string, workerSessionId: string): string {
  return `${activeDataOwnerId ?? ''}\u0000${leadSessionId}\u0000${workerSessionId}`;
}

function readTable(): Record<string, StoredAssignment> {
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<StoredAssignment>>;
    const now = Date.now();
    const table = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) =>
        !!value?.assignment
        && (value.state === 'pending' || value.state === 'uncertain')
        && typeof value.createdAt === 'number'
        && now - value.createdAt <= STORAGE_TTL_MS),
    ) as Record<string, StoredAssignment>;
    // Initial tasks are user-authored text. Enforce the declared TTL on read as well as write so
    // an owner with no later assignments does not retain expired/corrupt content indefinitely.
    if (Object.keys(table).length !== Object.keys(parsed).length) writeTable(table);
    return table;
  } catch {
    writeTable({});
    return {};
  }
}

function writeTable(table: Record<string, StoredAssignment>): void {
  try {
    if (Object.keys(table).length === 0) window.localStorage.removeItem(storageKey());
    else window.localStorage.setItem(storageKey(), JSON.stringify(table));
  } catch {
    // Best-effort recovery only; storage failure must not block the Lead send.
  }
}

export function setDeferredUiAssignmentOwner(ownerId: string | null): void {
  activeDataOwnerId = ownerId;
}

/** Persist before the Lead delivery boundary so a failed send or renderer restart cannot orphan it. */
export function rememberDeferredUiAssignment(
  leadSessionId: string,
  assignment: DeferredUiAssignment | undefined,
): void {
  if (!assignment) return;
  consumedAssignments.delete(assignmentKey(leadSessionId, assignment.workerSessionId));
  const table = readTable();
  table[leadSessionId] = { assignment, state: 'pending', createdAt: Date.now() };
  writeTable(table);
}

/**
 * enableOrca 已建好 Worker、但本次明确要求延后派单时，保存最小交接凭据。
 * raw initialTask 保留到 accepted 点再由 main 包装 UI handoff，避免 renderer
 * 复制 prompt 规则。
 */
export function createDeferredUiAssignment(params: {
  options: EnableOrcaOptions;
  workerSessionId: string;
  snapshotBeforeMs: number;
  deviceId?: string;
}): DeferredUiAssignment | undefined {
  if (params.options.deferDelegateTask !== true) return undefined;
  const initialTask = params.options.delegateTask?.trim();
  if (!initialTask) return undefined;
  return {
    workerSessionId: params.workerSessionId,
    initialTask,
    snapshotBeforeMs: params.snapshotBeforeMs,
    ...(params.deviceId ? { deviceId: params.deviceId } : {}),
  };
}

export function getRecoverableDeferredUiAssignment(params: {
  leadSessionId: string;
  messages: ReadonlyArray<{
    role: string;
    createdAt?: string;
    isPendingPersist?: boolean;
  }>;
  /** Current device route after sticky-origin recovery; undefined means local/unresolved. */
  deviceId?: string;
  remoteRouteUnavailable: boolean;
}): DeferredUiAssignment | undefined {
  const stored = readTable()[params.leadSessionId];
  if (stored?.state !== 'pending') return undefined;
  if (
    stored.assignment.deviceId
    && (
      stored.assignment.deviceId !== params.deviceId
      || params.remoteRouteUnavailable
    )
  ) {
    return undefined;
  }
  const hasDurableUserAfterSnapshot = params.messages.some((message) => {
    if (message.role !== 'user' || message.isPendingPersist === true) return false;
    const createdAtMs = typeof message.createdAt === 'string'
      ? Date.parse(message.createdAt)
      : Number.NaN;
    return Number.isFinite(createdAtMs)
      && createdAtMs >= stored.assignment.snapshotBeforeMs;
  });
  return hasDurableUserAfterSnapshot ? stored.assignment : undefined;
}

/** Lead 首条输入 accepted 后才调用；此时 history 查询已能看到该输入。 */
export function dispatchDeferredUiAssignment(
  leadSessionId: string,
  assignment: DeferredUiAssignment | undefined,
  options: { waitForLeadHistory?: boolean } = {},
): Promise<void> {
  const existing = dispatchesInFlight.get(leadSessionId);
  if (existing) return existing;

  const operation = (async () => {
    const table = readTable();
    const stored = table[leadSessionId];
    // The persisted state is authoritative even when a caller still holds the original in-memory
    // receipt. Once an earlier invoke is uncertain, a stale explicit receipt must not retry it.
    if (stored?.state === 'uncertain') return;
    if (
      !stored
      && assignment
      && consumedAssignments.has(assignmentKey(leadSessionId, assignment.workerSessionId))
    ) return;
    const target = stored?.state === 'pending' ? stored.assignment : assignment;
    if (!target) return;
    // Persist the ambiguity boundary before the invoke. A crash or lost response after this point
    // must never cause an automatic retry of a task that may already be running.
    table[leadSessionId] = {
      assignment: target,
      state: 'uncertain',
      createdAt: stored?.createdAt ?? Date.now(),
    };
    writeTable(table);
    // Memory is the final at-most-once fence when localStorage is unavailable/full. Claim before
    // the invoke because a rejection may mean “response lost after host acceptance”, not failure.
    consumedAssignments.add(assignmentKey(leadSessionId, target.workerSessionId));
    const maker = target.deviceId
      ? makerApiForDevice(target.deviceId)
      : window.electronAPI.maker;
    await maker.dispatchOrcaUiAssignment(
      leadSessionId,
      target.workerSessionId,
      target.initialTask,
      target.snapshotBeforeMs,
      options.waitForLeadHistory !== false,
    );
    const latest = readTable();
    if (latest[leadSessionId]?.assignment.workerSessionId === target.workerSessionId) {
      delete latest[leadSessionId];
      writeTable(latest);
    }
  })();
  dispatchesInFlight.set(leadSessionId, operation);
  void operation.finally(() => {
    if (dispatchesInFlight.get(leadSessionId) === operation) {
      dispatchesInFlight.delete(leadSessionId);
    }
  }).catch(() => undefined);
  return operation;
}
