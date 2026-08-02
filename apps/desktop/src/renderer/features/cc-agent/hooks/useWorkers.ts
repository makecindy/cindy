/**
 * useWorkers — 封装 listWorkersByLead + ORCA_WORKER_CHANGED 实时刷新。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createLogger } from '@/lib/logger';
import { orcaWorkflowsFor, subscribeOrcaWorkerChanged } from '@/lib/makerTransport';
import { isActiveWorkerStatus, type OrcaWorkerStatus } from '../../../../shared/orca-worker-status';

const log = createLogger('useWorkers');

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

const DEFAULT_SOFT_LIMIT = 5;
const DEFAULT_HARD_LIMIT = 8;

interface WorkersSnapshot {
  workers: WorkerInfo[];
  softLimit: number;
  hardLimit: number;
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

const DEFAULT_SNAPSHOT: WorkersSnapshot = {
  workers: [],
  softLimit: DEFAULT_SOFT_LIMIT,
  hardLimit: DEFAULT_HARD_LIMIT,
};
const workersCache = new Map<string, WorkersSnapshot>();
const workersRequestSeq = new Map<string, number>();
const settingsRequestSeq = new Map<string, number>();
const latestWorkersRequest = new Map<string, Promise<WorkersRefreshResult>>();
const latestWorkersResult = new Map<string, WorkersRefreshResult>();
const cacheSubscribers = new Map<string, Set<() => void>>();

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

function readCachedSnapshot(leadSessionId: string | undefined): WorkersSnapshot {
  if (!leadSessionId) return DEFAULT_SNAPSHOT;
  return workersCache.get(leadSessionId) ?? DEFAULT_SNAPSHOT;
}

function writeCachedSnapshot(
  leadSessionId: string,
  patch: Partial<WorkersSnapshot>,
): WorkersSnapshot {
  const current = workersCache.get(leadSessionId) ?? DEFAULT_SNAPSHOT;
  const next = { ...current, ...patch };
  workersCache.set(leadSessionId, next);
  cacheSubscribers.get(leadSessionId)?.forEach((listener) => listener());
  return next;
}

function nextRequestId(sequences: Map<string, number>, leadSessionId: string): number {
  const next = (sequences.get(leadSessionId) ?? 0) + 1;
  sequences.set(leadSessionId, next);
  return next;
}

function subscribeCachedSnapshot(leadSessionId: string, listener: () => void): () => void {
  const listeners = cacheSubscribers.get(leadSessionId) ?? new Set<() => void>();
  listeners.add(listener);
  cacheSubscribers.set(leadSessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cacheSubscribers.delete(leadSessionId);
  };
}

async function refreshWorkersSnapshot(leadSessionId: string): Promise<WorkersRefreshResult> {
  const requestId = nextRequestId(workersRequestSeq, leadSessionId);
  const request = orcaWorkflowsFor(leadSessionId)
    .listWorkersByLead(leadSessionId)
    .then((records) => {
      const workers = (records as unknown as Array<Record<string, unknown>>).map(mapWorkerRecord);
      if (workersRequestSeq.get(leadSessionId) === requestId) {
        writeCachedSnapshot(leadSessionId, { workers });
        const result = { leadSessionId, requestId, status: 'applied' as const, workers };
        latestWorkersResult.set(leadSessionId, result);
        return result;
      }
      return null;
    })
    .catch((err) => {
      if (workersRequestSeq.get(leadSessionId) === requestId) {
        log.warn('listWorkersByLead failed', err instanceof Error ? err.message : String(err));
        const result = {
          leadSessionId,
          requestId,
          status: 'failed' as const,
          workers: readCachedSnapshot(leadSessionId).workers,
        };
        latestWorkersResult.set(leadSessionId, result);
        return result;
      }
      return null;
    })
    .then(async (result): Promise<WorkersRefreshResult> => {
      if (result) return result;
      // 本请求已被同 Lead 的更新请求 supersede。等待当前最新请求收敛后返回其明确
      // 结果，让调用方不会把 stale 完成误当成“最新列表确认不含目标 worker”。
      const latest = latestWorkersRequest.get(leadSessionId);
      if (latest && latest !== request) return latest;
      return (
        latestWorkersResult.get(leadSessionId) ?? {
          leadSessionId,
          requestId: workersRequestSeq.get(leadSessionId) ?? requestId,
          status: 'failed',
          workers: readCachedSnapshot(leadSessionId).workers,
        }
      );
    });
  latestWorkersRequest.set(leadSessionId, request);
  void request.finally(() => {
    if (latestWorkersRequest.get(leadSessionId) === request) {
      latestWorkersRequest.delete(leadSessionId);
    }
  });
  return request;
}

async function refreshSettingsSnapshot(leadSessionId: string): Promise<void> {
  const requestId = nextRequestId(settingsRequestSeq, leadSessionId);
  try {
    const settings = await orcaWorkflowsFor(leadSessionId).getCollaborationSettings();
    if (settingsRequestSeq.get(leadSessionId) !== requestId) return;
    const s = settings as Record<string, unknown> | undefined;
    if (!s) return;
    const patch: Partial<WorkersSnapshot> = {};
    if (typeof s.workerSoftLimit === 'number') patch.softLimit = s.workerSoftLimit;
    if (typeof s.workerHardLimit === 'number') patch.hardLimit = s.workerHardLimit;
    if (Object.keys(patch).length > 0) writeCachedSnapshot(leadSessionId, patch);
  } catch {
    // 设置读取失败沿用缓存 / 默认限额，不影响 worker 主视图。
  }
}

export function clearWorkersCache(leadSessionId?: string): void {
  if (leadSessionId) {
    workersCache.delete(leadSessionId);
    workersRequestSeq.delete(leadSessionId);
    settingsRequestSeq.delete(leadSessionId);
    latestWorkersRequest.delete(leadSessionId);
    latestWorkersResult.delete(leadSessionId);
    cacheSubscribers.get(leadSessionId)?.forEach((listener) => listener());
  } else {
    workersCache.clear();
    workersRequestSeq.clear();
    settingsRequestSeq.clear();
    latestWorkersRequest.clear();
    latestWorkersResult.clear();
    cacheSubscribers.forEach((listeners) => listeners.forEach((listener) => listener()));
  }
}

function updateHookSnapshot(
  setHookSnapshot: Dispatch<SetStateAction<{
    leadSessionId: string | undefined;
    snapshot: WorkersSnapshot;
  }>>,
  leadSessionId: string | undefined,
): void {
  setHookSnapshot((previous) => {
    const snapshot = readCachedSnapshot(leadSessionId);
    return previous.leadSessionId === leadSessionId && previous.snapshot === snapshot
      ? previous
      : { leadSessionId, snapshot };
  });
}

export function useWorkers(leadSessionId: string | undefined) {
  const [hookSnapshot, setHookSnapshot] = useState<{
    leadSessionId: string | undefined;
    snapshot: WorkersSnapshot;
  }>(() => ({ leadSessionId, snapshot: readCachedSnapshot(leadSessionId) }));
  const currentLeadSessionIdRef = useRef(leadSessionId);
  currentLeadSessionIdRef.current = leadSessionId;

  const refresh = useCallback(async (): Promise<WorkersRefreshResult | null> => {
    if (!leadSessionId) {
      updateHookSnapshot(setHookSnapshot, undefined);
      return null;
    }
    // device-link:远程 lead 走隧道读被控端团队;本机 lead 原样走本机 DB(orcaWorkflowsFor 分流)。
    return refreshWorkersSnapshot(leadSessionId);
  }, [leadSessionId]);

  const refreshCreationState = useCallback(async (): Promise<WorkerCreationRefreshResult> => {
    if (!leadSessionId) return { status: 'failed', workers: [], hardLimit: null };
    const [workersResult, settings] = await Promise.all([
      refreshWorkersSnapshot(leadSessionId),
      orcaWorkflowsFor(leadSessionId)
        .getCollaborationSettings()
        .catch(() => null),
    ]);
    const rawHardLimit = (settings as Record<string, unknown> | null)?.workerHardLimit;
    const hardLimit =
      typeof rawHardLimit === 'number' && Number.isFinite(rawHardLimit) && rawHardLimit >= 0
        ? rawHardLimit
        : null;
    if (workersResult.status !== 'applied' || hardLimit === null) {
      return { status: 'failed', workers: workersResult.workers, hardLimit };
    }
    return { status: 'applied', workers: workersResult.workers, hardLimit };
  }, [leadSessionId]);

  useEffect(() => {
    updateHookSnapshot(setHookSnapshot, leadSessionId);
    if (!leadSessionId) return;
    return subscribeCachedSnapshot(leadSessionId, () => {
      // lead 切换 render 与旧 effect cleanup 之间仍可能收到旧 Lead 通知；同步 ref
      // 守住最后一道边界，旧 Lead 永远不能 set 当前 hook snapshot。
      if (currentLeadSessionIdRef.current !== leadSessionId) return;
      updateHookSnapshot(setHookSnapshot, leadSessionId);
    });
  }, [leadSessionId]);

  useEffect(() => {
    if (!leadSessionId) return;
    void refresh();
    void refreshSettingsSnapshot(leadSessionId);
  }, [leadSessionId, refresh]);

  // worker 变更实时刷新:按 lead 来源分流(本机 IPC 推送 / device-link 远程推送),
  // 被控端 worker-changed 经隧道转发并按 leadSessionId 过滤。见 subscribeOrcaWorkerChanged。
  useEffect(() => {
    if (!leadSessionId) return;
    return subscribeOrcaWorkerChanged(leadSessionId, refresh);
  }, [refresh, leadSessionId]);

  // lead prop 切换发生在 effect cleanup 之前；render 阶段若 state 仍属于旧 Lead，
  // 同步改读新 Lead cache，绝不把旧 worker 列表闪到新会话首帧。
  const currentSnapshot =
    hookSnapshot.leadSessionId === leadSessionId
      ? hookSnapshot.snapshot
      : readCachedSnapshot(leadSessionId);
  const { workers, softLimit, hardLimit } = currentSnapshot;
  const focusedWorker = workers.find((w) => w.focused) ?? workers[0] ?? null;
  // 与后端 activeCount 共用 shared/orca-worker-status 的判定, 避免漂移 (F6)。
  // primitive 返回值不需要 useMemo 稳定身份。
  const activeWorkerCount = workers.filter((w) => isActiveWorkerStatus(w.status)).length;

  return {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    refreshCreationState,
  };
}
