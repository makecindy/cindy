import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { createLogger } from '@/lib/logger';
import {
  isRemoteSessionSticky,
  orcaWorkflowsFor,
  orcaWorkflowsForDevice,
  subscribeOrcaWorkerChanged,
} from '@/lib/makerTransport';
import { isActiveWorkerStatus, type OrcaWorkerStatus } from '../../../../shared/orca-worker-status';

const log = createLogger('workerProjectionStore');

export interface WorkerInfo {
  workerId: string;
  sessionId: string;
  role: string;
  agent: 'claude-code' | 'codex' | 'pi';
  model: string;
  effort: string | null;
  label: string | null;
  status: OrcaWorkerStatus;
  focused: boolean;
  idleSince: string | null;
}

export interface WorkersSnapshot {
  workers: WorkerInfo[];
  softLimit: number;
  hardLimit: number;
  workerStatus: 'idle' | 'applied' | 'failed';
  requestId: number;
  updatedAt: number;
}

export interface WorkersRefreshResult {
  leadSessionId: string;
  requestId: number;
  status: 'applied' | 'failed';
  workers: WorkerInfo[];
}

export interface WorkerCreationRefreshResult {
  status: 'applied' | 'failed';
  workers: WorkerInfo[];
  hardLimit: number | null;
}

const DEFAULT_SOFT_LIMIT = 5;
const DEFAULT_HARD_LIMIT = 8;
const DEFAULT_SNAPSHOT: WorkersSnapshot = {
  workers: [],
  softLimit: DEFAULT_SOFT_LIMIT,
  hardLimit: DEFAULT_HARD_LIMIT,
  workerStatus: 'idle',
  requestId: 0,
  updatedAt: 0,
};
const DEFAULT_COALESCE_MS = 100;
const ACTIVE_REVALIDATE_FRESH_MS = 1_000;
const LOCAL_BATCH_CHUNK_SIZE = 200;

interface LeadEntry {
  snapshot: WorkersSnapshot;
  listeners: Set<() => void>;
  ownerCount: number;
  unsubscribe: (() => void) | null;
  requestSeq: number;
  settingsSeq: number;
  inFlight: Promise<WorkersRefreshResult> | null;
  queuedRefresh: QueuedRefresh | null;
  authoritativeWaiters: Set<(value: WorkersRefreshResult) => void>;
  settingsInFlight: Promise<WorkerSettingsRefreshResult> | null;
  settingsUpdatedAt: number;
}

interface QueuedRefresh {
  promise: Promise<WorkersRefreshResult>;
  resolve: (value: WorkersRefreshResult) => void;
  timer: number | null;
  ready: boolean;
}

interface WorkerSettingsRefreshResult {
  status: 'applied' | 'failed';
  hardLimit: number | null;
}

interface LocalBatchItem {
  leadSessionId: string;
  requestId: number;
  entry: LeadEntry;
  resolve: (value: WorkersRefreshResult) => void;
}

let coalesceMs = DEFAULT_COALESCE_MS;
const entries = new Map<string, LeadEntry>();
let globalVersion = 0;
const globalListeners = new Set<() => void>();
let localBatchTimer: number | null = null;
const localBatchQueue = new Map<string, LocalBatchItem>();

function nowMs(): number {
  return Date.now();
}

function scheduleTimer(cb: () => void, delayMs: number): number {
  return window.setTimeout(cb, delayMs);
}

function clearTimer(timer: number): void {
  window.clearTimeout(timer);
}

function stableLeadSessionIds(leadSessionIds: readonly string[]): string[] {
  return [...new Set(leadSessionIds)].sort();
}

function stableLeadSessionIdsKey(leadSessionIds: readonly string[]): string {
  return stableLeadSessionIds(leadSessionIds).join('\0');
}

function emitGlobal(): void {
  globalVersion += 1;
  for (const listener of globalListeners) listener();
}

function emitEntry(entry: LeadEntry): void {
  for (const listener of entry.listeners) listener();
  emitGlobal();
}

function getEntry(leadSessionId: string): LeadEntry {
  let entry = entries.get(leadSessionId);
  if (!entry) {
    entry = {
      snapshot: DEFAULT_SNAPSHOT,
      listeners: new Set(),
      ownerCount: 0,
      unsubscribe: null,
      requestSeq: 0,
      settingsSeq: 0,
      inFlight: null,
      queuedRefresh: null,
      authoritativeWaiters: new Set(),
      settingsInFlight: null,
      settingsUpdatedAt: 0,
    };
    entries.set(leadSessionId, entry);
  }
  return entry;
}

function mapWorkerRecord(raw: Record<string, unknown>): WorkerInfo {
  const session = raw.session as Record<string, unknown> | undefined;
  return {
    workerId: raw.id as string,
    sessionId: raw.sessionId as string,
    role: (raw.role as string) ?? 'developer',
    agent:
      session?.agentKind === 'codex' ? 'codex' : session?.agentKind === 'pi' ? 'pi' : 'claude-code',
    model: (session?.model as string) ?? 'claude-sonnet-4-6',
    effort: (session?.effort as string | null) ?? null,
    label: (raw.label as string | null) ?? null,
    status: (raw.status as WorkerInfo['status']) ?? 'idle',
    focused: (raw.focused as boolean) ?? false,
    idleSince: (raw.idleSince as string | null) ?? null,
  };
}

function writeWorkersSnapshot(
  leadSessionId: string,
  entry: LeadEntry,
  requestId: number,
  status: WorkersSnapshot['workerStatus'],
  workers: WorkerInfo[],
): WorkersRefreshResult {
  entry.snapshot = {
    ...entry.snapshot,
    workers,
    workerStatus: status,
    requestId,
    updatedAt: nowMs(),
  };
  emitEntry(entry);
  return { leadSessionId, requestId, status: status === 'applied' ? 'applied' : 'failed', workers };
}

function failedWorkersResult(leadSessionId: string, entry: LeadEntry): WorkersRefreshResult {
  return {
    leadSessionId,
    requestId: entry.requestSeq,
    status: 'failed',
    workers: entry.snapshot.workers,
  };
}

function resolveAuthoritativeWaiters(entry: LeadEntry, result: WorkersRefreshResult): void {
  if (entry.inFlight || entry.queuedRefresh || entry.authoritativeWaiters.size === 0) return;
  const waiters = [...entry.authoritativeWaiters];
  entry.authoritativeWaiters.clear();
  for (const resolve of waiters) resolve(result);
}

function maybeStartQueuedRefresh(leadSessionId: string, entry: LeadEntry): void {
  const queued = entry.queuedRefresh;
  if (!queued?.ready || entry.inFlight) return;
  entry.queuedRefresh = null;
  if (queued.timer !== null) clearTimer(queued.timer);
  const request = startLeadRequest(leadSessionId, entry);
  void request.then(queued.resolve);
}

function finishLeadRequest(
  leadSessionId: string,
  entry: LeadEntry,
  request: Promise<WorkersRefreshResult>,
): void {
  void request.then((result) => {
    if (entry.inFlight !== request) return;
    entry.inFlight = null;
    maybeStartQueuedRefresh(leadSessionId, entry);
    resolveAuthoritativeWaiters(entry, result);
  });
}

function normalizeBatchResponse(
  response: unknown,
): Record<string, Array<Record<string, unknown>>> {
  if (!response || typeof response !== 'object') return {};
  return response as Record<string, Array<Record<string, unknown>>>;
}

function hasOwnKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function projectionWorkflowsFor(leadSessionId: string) {
  const deviceId = getStickySessionDeviceId(leadSessionId);
  return deviceId ? orcaWorkflowsForDevice(deviceId) : orcaWorkflowsFor(leadSessionId);
}

async function listLocalWorkersByLeads(
  leadSessionIds: readonly string[],
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const batchApi = window.electronAPI.localDb.orcaWorkflows.listWorkersByLeads;
  if (!batchApi) {
    const rows = await Promise.all(
      leadSessionIds.map(async (leadSessionId) => {
        const workers = await window.electronAPI.localDb.orcaWorkflows.listWorkersByLead(
          leadSessionId,
        );
        return [
          leadSessionId,
          workers as unknown as Array<Record<string, unknown>>,
        ] as const;
      }),
    );
    return Object.fromEntries(rows);
  }

  const chunks: string[][] = [];
  for (let index = 0; index < leadSessionIds.length; index += LOCAL_BATCH_CHUNK_SIZE) {
    chunks.push(leadSessionIds.slice(index, index + LOCAL_BATCH_CHUNK_SIZE));
  }
  const responses = await Promise.all(chunks.map((chunk) => batchApi(chunk)));
  return Object.assign({}, ...responses.map(normalizeBatchResponse));
}

function flushLocalBatch(): void {
  localBatchTimer = null;
  const batch = [...localBatchQueue.values()];
  localBatchQueue.clear();
  if (batch.length === 0) return;
  const leadSessionIds = batch.map((item) => item.leadSessionId);
  const request = listLocalWorkersByLeads(leadSessionIds);
  void request
    .then((raw) => {
      const grouped = normalizeBatchResponse(raw);
      for (const item of batch) {
        if (item.entry.requestSeq !== item.requestId) {
          item.resolve({
            leadSessionId: item.leadSessionId,
            requestId: item.entry.requestSeq,
            status: 'failed',
            workers: item.entry.snapshot.workers,
          });
        } else {
          const records = grouped[item.leadSessionId];
          if (!hasOwnKey(grouped, item.leadSessionId) || !Array.isArray(records)) {
            log.warn('listWorkersByLeads returned invalid lead entry', {
              leadSessionId: item.leadSessionId,
            });
            item.resolve(writeWorkersSnapshot(
              item.leadSessionId,
              item.entry,
              item.requestId,
              'failed',
              item.entry.snapshot.workers,
            ));
            continue;
          }
          const workers = records.map(mapWorkerRecord);
          item.resolve(writeWorkersSnapshot(
            item.leadSessionId,
            item.entry,
            item.requestId,
            'applied',
            workers,
          ));
        }
      }
    })
    .catch((err) => {
      log.warn('listWorkersByLeads failed', err instanceof Error ? err.message : String(err));
      for (const item of batch) {
        item.resolve(
          item.entry.requestSeq === item.requestId
            ? writeWorkersSnapshot(
                item.leadSessionId,
                item.entry,
                item.requestId,
                'failed',
                item.entry.snapshot.workers,
              )
            : failedWorkersResult(item.leadSessionId, item.entry),
        );
      }
    });
}

function enqueueLocalBatch(
  leadSessionId: string,
  entry: LeadEntry,
  requestId: number,
): Promise<WorkersRefreshResult> {
  const request = new Promise<WorkersRefreshResult>((resolve) => {
    localBatchQueue.set(leadSessionId, { leadSessionId, requestId, entry, resolve });
    if (localBatchTimer === null) {
      localBatchTimer = scheduleTimer(flushLocalBatch, 0);
    }
  });
  entry.inFlight = request;
  finishLeadRequest(leadSessionId, entry, request);
  return request;
}

function startRemoteLeadRequest(
  leadSessionId: string,
  entry: LeadEntry,
  requestId: number,
): Promise<WorkersRefreshResult> {
  const request = projectionWorkflowsFor(leadSessionId)
    .listWorkersByLead(leadSessionId)
    .then((records) => {
      if (entry.requestSeq !== requestId) {
        return {
          leadSessionId,
          requestId: entry.requestSeq,
          status: 'failed' as const,
          workers: entry.snapshot.workers,
        };
      }
      const workers = (records as unknown as Array<Record<string, unknown>>).map(mapWorkerRecord);
      return writeWorkersSnapshot(leadSessionId, entry, requestId, 'applied', workers);
    })
    .catch((err) => {
      if (entry.requestSeq === requestId) {
        log.warn('listWorkersByLead failed', err instanceof Error ? err.message : String(err));
        return writeWorkersSnapshot(
          leadSessionId,
          entry,
          requestId,
          'failed',
          entry.snapshot.workers,
        );
      }
      return {
        leadSessionId,
        requestId: entry.requestSeq,
        status: 'failed' as const,
        workers: entry.snapshot.workers,
      };
    });
  entry.inFlight = request;
  finishLeadRequest(leadSessionId, entry, request);
  return request;
}

function requestWorkersProjection(
  leadSessionId: string,
  options: {
    mode?: 'join' | 'active' | 'authoritative' | 'event';
    minFreshMs?: number;
  } = {},
): Promise<WorkersRefreshResult> {
  const entry = getEntry(leadSessionId);
  const mode = options.mode ?? 'join';
  const minFreshMs = options.minFreshMs ?? 0;
  if (
    mode === 'active' &&
    minFreshMs > 0 &&
    entry.snapshot.workerStatus === 'applied' &&
    nowMs() - entry.snapshot.updatedAt <= minFreshMs
  ) {
    return Promise.resolve({
      leadSessionId,
      requestId: entry.snapshot.requestId,
      status: 'applied',
      workers: entry.snapshot.workers,
    });
  }

  if (mode === 'event') {
    return queueWorkersRefresh(leadSessionId, entry, coalesceMs);
  }

  if (mode === 'authoritative') {
    const settled = new Promise<WorkersRefreshResult>((resolve) => {
      entry.authoritativeWaiters.add(resolve);
    });
    if (entry.inFlight || entry.queuedRefresh) {
      void queueWorkersRefresh(leadSessionId, entry, 0);
    } else {
      startLeadRequest(leadSessionId, entry);
    }
    return settled;
  }

  if (entry.inFlight) return entry.inFlight;
  if (entry.queuedRefresh) return entry.queuedRefresh.promise;
  return startLeadRequest(leadSessionId, entry);
}

function queueWorkersRefresh(
  leadSessionId: string,
  entry: LeadEntry,
  delayMs: number,
): Promise<WorkersRefreshResult> {
  const existing = entry.queuedRefresh;
  if (existing) {
    if (delayMs === 0 && !existing.ready) {
      if (existing.timer !== null) clearTimer(existing.timer);
      existing.timer = null;
      existing.ready = true;
      maybeStartQueuedRefresh(leadSessionId, entry);
    } else if (delayMs > 0 && !existing.ready) {
      if (existing.timer !== null) clearTimer(existing.timer);
      existing.timer = scheduleTimer(() => {
        existing.timer = null;
        existing.ready = true;
        maybeStartQueuedRefresh(leadSessionId, entry);
      }, delayMs);
    }
    return existing.promise;
  }

  let resolveQueued!: (value: WorkersRefreshResult) => void;
  const queued: QueuedRefresh = {
    promise: new Promise<WorkersRefreshResult>((resolve) => {
      resolveQueued = resolve;
    }),
    resolve: (value) => resolveQueued(value),
    timer: null,
    ready: delayMs === 0,
  };
  entry.queuedRefresh = queued;
  if (delayMs > 0) {
    queued.timer = scheduleTimer(() => {
      queued.timer = null;
      queued.ready = true;
      maybeStartQueuedRefresh(leadSessionId, entry);
    }, delayMs);
  }
  maybeStartQueuedRefresh(leadSessionId, entry);
  return queued.promise;
}

function startLeadRequest(
  leadSessionId: string,
  entry: LeadEntry,
): Promise<WorkersRefreshResult> {
  const requestId = entry.requestSeq + 1;
  entry.requestSeq = requestId;
  if (isRemoteSessionSticky(leadSessionId)) {
    return startRemoteLeadRequest(leadSessionId, entry, requestId);
  }
  return enqueueLocalBatch(leadSessionId, entry, requestId);
}

function invalidateLead(leadSessionId: string): void {
  const entry = getEntry(leadSessionId);
  if (entry.ownerCount <= 0) return;
  void requestWorkersProjection(leadSessionId, { mode: 'event' });
}

export function retainWorkerProjection(leadSessionId: string | undefined): () => void {
  if (!leadSessionId) return () => undefined;
  const entry = getEntry(leadSessionId);
  entry.ownerCount += 1;
  if (entry.ownerCount === 1) {
    entry.unsubscribe = subscribeOrcaWorkerChanged(leadSessionId, () => invalidateLead(leadSessionId));
    void requestWorkersProjection(leadSessionId);
  }
  return () => {
    entry.ownerCount = Math.max(0, entry.ownerCount - 1);
    if (entry.ownerCount !== 0) return;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    if (entry.queuedRefresh && entry.authoritativeWaiters.size === 0) {
      if (entry.queuedRefresh.timer !== null) clearTimer(entry.queuedRefresh.timer);
      entry.queuedRefresh.resolve(failedWorkersResult(leadSessionId, entry));
      entry.queuedRefresh = null;
    }
  };
}

export function useWorkerProjectionOwner(leadSessionId: string | undefined): void {
  useEffect(() => retainWorkerProjection(leadSessionId), [leadSessionId]);
}

export function useWorkerProjectionOwners(leadSessionIds: readonly string[]): void {
  const key = stableLeadSessionIdsKey(leadSessionIds);
  const retainedRef = useRef<Map<string, () => void>>(new Map());
  const stableIds = useMemo(() => (key.length > 0 ? key.split('\0') : []), [key]);

  useEffect(() => {
    const retained = retainedRef.current;
    const next = new Set(stableIds);
    for (const [leadSessionId, release] of retained) {
      if (!next.has(leadSessionId)) {
        release();
        retained.delete(leadSessionId);
      }
    }
    for (const leadSessionId of stableIds) {
      if (!retained.has(leadSessionId)) {
        retained.set(leadSessionId, retainWorkerProjection(leadSessionId));
      }
    }
  }, [stableIds]);

  useEffect(() => {
    return () => {
      const retained = retainedRef.current;
      for (const release of retained.values()) release();
      retained.clear();
    };
  }, []);
}

export function getWorkerProjectionSnapshot(
  leadSessionId: string | undefined,
): WorkersSnapshot {
  if (!leadSessionId) return DEFAULT_SNAPSHOT;
  return entries.get(leadSessionId)?.snapshot ?? DEFAULT_SNAPSHOT;
}

export function subscribeWorkerProjection(
  leadSessionId: string | undefined,
  listener: () => void,
): () => void {
  if (!leadSessionId) return () => undefined;
  const entry = getEntry(leadSessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function useWorkerProjection(leadSessionId: string | undefined): WorkersSnapshot {
  return useSyncExternalStore(
    (listener) => subscribeWorkerProjection(leadSessionId, listener),
    () => getWorkerProjectionSnapshot(leadSessionId),
    () => getWorkerProjectionSnapshot(leadSessionId),
  );
}

export function subscribeAllWorkerProjections(listener: () => void): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function getAllWorkerProjectionVersion(): number {
  return globalVersion;
}

export function useWorkerProjectionVersion(): number {
  return useSyncExternalStore(
    subscribeAllWorkerProjections,
    getAllWorkerProjectionVersion,
    getAllWorkerProjectionVersion,
  );
}

export function revalidateWorkersProjection(
  leadSessionId: string,
): Promise<WorkersRefreshResult> {
  return requestWorkersProjection(leadSessionId, { mode: 'authoritative' });
}

export function revalidateActiveWorkersProjection(leadSessionId: string): Promise<WorkersRefreshResult> {
  return requestWorkersProjection(leadSessionId, {
    mode: 'active',
    minFreshMs: ACTIVE_REVALIDATE_FRESH_MS,
  });
}

function requestWorkerSettings(
  leadSessionId: string,
  minFreshMs = 0,
): Promise<WorkerSettingsRefreshResult> {
  const entry = getEntry(leadSessionId);
  if (minFreshMs > 0 && nowMs() - entry.settingsUpdatedAt <= minFreshMs) {
    return Promise.resolve({ status: 'applied', hardLimit: entry.snapshot.hardLimit });
  }
  if (entry.settingsInFlight) return entry.settingsInFlight;

  const requestId = entry.settingsSeq + 1;
  entry.settingsSeq = requestId;
  const request = projectionWorkflowsFor(leadSessionId)
    .getCollaborationSettings()
    .then((settings) => {
      if (entry.settingsSeq !== requestId) return { status: 'failed' as const, hardLimit: null };
      const raw = settings as Record<string, unknown> | null;
      const rawHardLimit = raw?.workerHardLimit;
      const rawSoftLimit = raw?.workerSoftLimit;
      const hardLimit =
        typeof rawHardLimit === 'number' && Number.isFinite(rawHardLimit) && rawHardLimit >= 0
          ? rawHardLimit
          : null;
      const softLimit =
        typeof rawSoftLimit === 'number' && Number.isFinite(rawSoftLimit) && rawSoftLimit >= 0
          ? rawSoftLimit
          : null;
      if (hardLimit === null) return { status: 'failed' as const, hardLimit: null };
      entry.snapshot = {
        ...entry.snapshot,
        hardLimit,
        ...(softLimit !== null ? { softLimit } : {}),
      };
      entry.settingsUpdatedAt = nowMs();
      emitEntry(entry);
      return { status: 'applied' as const, hardLimit };
    })
    .catch(() => ({ status: 'failed' as const, hardLimit: null }));
  entry.settingsInFlight = request;
  void request.finally(() => {
    if (entry.settingsInFlight === request) entry.settingsInFlight = null;
  });
  return request;
}

export function revalidateActiveWorkerSettings(
  leadSessionId: string,
): Promise<WorkerSettingsRefreshResult> {
  return requestWorkerSettings(leadSessionId, ACTIVE_REVALIDATE_FRESH_MS);
}

export async function refreshWorkerCreationState(
  leadSessionId: string,
): Promise<WorkerCreationRefreshResult> {
  const [workersResult, settingsResult] = await Promise.all([
    requestWorkersProjection(leadSessionId, { mode: 'authoritative' }),
    requestWorkerSettings(leadSessionId),
  ]);
  if (workersResult.status !== 'applied' || settingsResult.status !== 'applied') {
    return {
      status: 'failed',
      workers: workersResult.workers,
      hardLimit: settingsResult.hardLimit,
    };
  }
  return {
    status: 'applied',
    workers: workersResult.workers,
    hardLimit: settingsResult.hardLimit,
  };
}

export function getActiveWorkerCount(workers: readonly WorkerInfo[]): number {
  return workers.filter((w) => isActiveWorkerStatus(w.status)).length;
}

export function clearWorkerProjectionStore(leadSessionId?: string): void {
  const clearEntry = (id: string, entry: LeadEntry) => {
    entry.requestSeq += 1;
    entry.settingsSeq += 1;
    entry.inFlight = null;
    entry.settingsInFlight = null;
    const failed = failedWorkersResult(id, entry);
    const queuedBatchItem = localBatchQueue.get(id);
    if (queuedBatchItem?.entry === entry) {
      localBatchQueue.delete(id);
      queuedBatchItem.resolve(failed);
    }
    if (entry.queuedRefresh) {
      if (entry.queuedRefresh.timer !== null) clearTimer(entry.queuedRefresh.timer);
      entry.queuedRefresh.resolve(failed);
      entry.queuedRefresh = null;
    }
    for (const resolve of entry.authoritativeWaiters) resolve(failed);
    entry.authoritativeWaiters.clear();
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.snapshot = { ...DEFAULT_SNAPSHOT };
    entry.settingsUpdatedAt = 0;
    emitEntry(entry);

    if (entry.ownerCount > 0) {
      entry.unsubscribe = subscribeOrcaWorkerChanged(id, () => invalidateLead(id));
      void requestWorkersProjection(id);
    } else if (entry.listeners.size === 0) {
      entries.delete(id);
    }
  };
  if (leadSessionId) {
    const entry = entries.get(leadSessionId);
    if (entry) clearEntry(leadSessionId, entry);
  } else {
    for (const [id, entry] of entries) clearEntry(id, entry);
  }
  if (localBatchQueue.size === 0 && localBatchTimer !== null) {
    clearTimer(localBatchTimer);
    localBatchTimer = null;
  }
  emitGlobal();
}

export function __setWorkerProjectionCoalesceMsForTest(value: number): void {
  coalesceMs = value;
}

export function __getWorkerProjectionOwnerCountForTest(leadSessionId: string): number {
  return entries.get(leadSessionId)?.ownerCount ?? 0;
}
