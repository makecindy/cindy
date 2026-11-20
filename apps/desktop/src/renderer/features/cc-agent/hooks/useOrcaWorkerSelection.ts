import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';

import { toast } from '@/lib/toast';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { orcaWorkflowsFor, orcaWorkflowsForDevice } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';
import {
  parseConversationSearchJump,
  type ConversationSearchJump,
} from '../../../../shared/conversationSearchJump';
import type { CreateWorkerForm } from '../CreateWorkerPopover';
import type { EditWorkerForm } from '../EditWorkerPopover';
import {
  executionDeviceErrorMessage,
  getCollaborationStartErrorMessage,
  workerAgentDeviceErrorMessage,
} from '../collaborationErrors';
import { createWorkerLabel } from '../workerLabel';
import { useWorkers } from './useWorkers';
import { clearWorkerAttention } from '../lib/workerAttentionStore';

const log = createLogger('OrcaWorkerSelection');

interface BrowseIntent {
  scope: string;
  workerId: string;
  hintRevision: number;
}

// A dispatched focus write must settle before another write can change the same lead.
// Queued clicks only need to apply the latest intent.
const focusWrites = new Map<string, { latest: BrowseIntent; tail?: Promise<boolean> }>();

function parseSearchJump(state: unknown): ConversationSearchJump | null {
  if (!state || typeof state !== 'object') return null;
  return parseConversationSearchJump((state as { searchJump?: unknown }).searchJump);
}

export interface UseOrcaWorkerSelectionOptions {
  leadSessionId: string;
  deviceId?: string;
  /** Whether the worker conversation is actually visible to the user. */
  viewVisible: boolean;
  focusWorkerSessionId?: string | null;
  focusWorkerHintRevision?: number;
  searchJump?: ConversationSearchJump | null;
  onFocusWorkerSessionIdConsumed?: (revision: number) => void;
  onSelectionIntentCleared?: (revision: number) => void;
}

export function useOrcaWorkerSelection({
  leadSessionId,
  deviceId,
  viewVisible,
  focusWorkerSessionId,
  focusWorkerHintRevision,
  searchJump: searchJumpProp,
  onFocusWorkerSessionIdConsumed,
  onSelectionIntentCleared,
}: UseOrcaWorkerSelectionOptions) {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    refreshCreationState,
  } = useWorkers(leadSessionId);
  const [createOpen, setCreateOpen] = useState(false);
  const [editWorkerId, setEditWorkerId] = useState<string | null>(null);
  const [searchJumpPinnedWorkerSessionId, setSearchJumpPinnedWorkerSessionId] = useState<
    string | null
  >(null);
  const [focusWorkerPinnedSessionId, setFocusWorkerPinnedSessionId] = useState<string | null>(null);
  const activeFocusWorkerHintRevisionRef = useRef(0);
  const selectionIntentGenerationRef = useRef(0);
  const pendingFocusTimeoutRef = useRef<number | null>(null);
  const acknowledgingDoneWorkerIdsRef = useRef<Set<string>>(new Set());
  const focusWorkerSessionIdRef = useRef(focusWorkerSessionId);
  focusWorkerSessionIdRef.current = focusWorkerSessionId;
  const onFocusWorkerSessionIdConsumedRef = useRef(onFocusWorkerSessionIdConsumed);
  onFocusWorkerSessionIdConsumedRef.current = onFocusWorkerSessionIdConsumed;
  const workersRef = useRef(workers);
  workersRef.current = workers;
  const [pendingFocusWorkerSessionId, setPendingFocusWorkerSessionId] = useState<string | null>(
    null,
  );

  const urlWorkerSessionId = searchParams.get('worker');
  const focusWorkerHintSessionId = focusWorkerSessionId || focusWorkerPinnedSessionId;
  const explicitWorkerSessionId = focusWorkerHintSessionId || urlWorkerSessionId;
  const locationSearchJump = useMemo(() => parseSearchJump(location.state), [location.state]);
  const searchJump = searchJumpProp !== undefined ? searchJumpProp : locationSearchJump;
  const searchJumpSessionId = searchJump?.sessionId ?? null;
  const normalizedFocusWorkerHintRevision =
    focusWorkerHintRevision ?? (focusWorkerSessionId ? 1 : 0);
  const owner = getDataOwnerGeneration();
  const browseScope = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, leadSessionId]);
  const visibleScope = useRef<string | null>(null);
  const visibleRef = useRef(viewVisible);
  const latestBrowseIntent = useRef<BrowseIntent | null>(null);
  const [browse, setBrowse] = useState<{ intent: BrowseIntent; confirmed: boolean } | null>(null);
  useLayoutEffect(() => {
    visibleScope.current = browseScope;
    setBrowse((current) => current?.intent.scope === browseScope ? current : null);
    return () => {
      latestBrowseIntent.current = null;
      visibleScope.current = null;
    };
  }, [browseScope]);
  useLayoutEffect(() => { visibleRef.current = viewVisible; }, [viewVisible]);
  const activeBrowse = browse?.intent.scope === browseScope &&
    browse.intent.hintRevision === normalizedFocusWorkerHintRevision ? browse : null;
  const browseWorker = activeBrowse && workers.find((worker) => worker.workerId === activeBrowse.intent.workerId);

  useEffect(() => {
    selectionIntentGenerationRef.current += 1;
    if (pendingFocusTimeoutRef.current !== null) {
      window.clearTimeout(pendingFocusTimeoutRef.current);
      pendingFocusTimeoutRef.current = null;
    }
    activeFocusWorkerHintRevisionRef.current = 0;
    setSearchJumpPinnedWorkerSessionId(null);
    setFocusWorkerPinnedSessionId(null);
    setPendingFocusWorkerSessionId(null);
    setEditWorkerId(null);
  }, [leadSessionId]);

  const searchJumpWorkerSessionId = useMemo(
    () =>
      searchJumpSessionId && searchJumpSessionId === explicitWorkerSessionId
        ? searchJumpSessionId
        : null,
    [explicitWorkerSessionId, searchJumpSessionId],
  );
  const effectiveSearchJumpWorkerSessionId =
    searchJumpWorkerSessionId ??
    (searchJumpPinnedWorkerSessionId === explicitWorkerSessionId
      ? searchJumpPinnedWorkerSessionId
      : null);

  useEffect(() => {
    if (searchJumpWorkerSessionId) {
      setSearchJumpPinnedWorkerSessionId(searchJumpWorkerSessionId);
    }
  }, [searchJumpWorkerSessionId]);

  useEffect(() => {
    if (
      searchJumpPinnedWorkerSessionId &&
      explicitWorkerSessionId !== searchJumpPinnedWorkerSessionId
    ) {
      setSearchJumpPinnedWorkerSessionId(null);
    }
  }, [explicitWorkerSessionId, searchJumpPinnedWorkerSessionId]);

  useEffect(() => {
    if (
      normalizedFocusWorkerHintRevision === 0 ||
      activeFocusWorkerHintRevisionRef.current === normalizedFocusWorkerHintRevision
    ) {
      return;
    }
    const generation = selectionIntentGenerationRef.current + 1;
    selectionIntentGenerationRef.current = generation;
    if (pendingFocusTimeoutRef.current !== null) {
      window.clearTimeout(pendingFocusTimeoutRef.current);
      pendingFocusTimeoutRef.current = null;
    }
    activeFocusWorkerHintRevisionRef.current = normalizedFocusWorkerHintRevision;
    const focusIntentSessionId = focusWorkerSessionIdRef.current;
    if (!focusIntentSessionId) {
      setFocusWorkerPinnedSessionId(null);
      setPendingFocusWorkerSessionId(null);
      return;
    }
    const targetSessionId = focusIntentSessionId;
    setFocusWorkerPinnedSessionId(focusIntentSessionId);
    onFocusWorkerSessionIdConsumedRef.current?.(normalizedFocusWorkerHintRevision);

    if (workersRef.current.some((worker) => worker.sessionId === focusIntentSessionId)) {
      setPendingFocusWorkerSessionId(null);
      return;
    }

    setPendingFocusWorkerSessionId(focusIntentSessionId);

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (pendingFocusTimeoutRef.current === timeout) pendingFocusTimeoutRef.current = null;
      if (
        !cancelled &&
        activeFocusWorkerHintRevisionRef.current === normalizedFocusWorkerHintRevision &&
        selectionIntentGenerationRef.current === generation &&
        !workersRef.current.some((worker) => worker.sessionId === targetSessionId)
      ) {
        setPendingFocusWorkerSessionId(null);
        setFocusWorkerPinnedSessionId(null);
      }
    }, 5000);
    pendingFocusTimeoutRef.current = timeout;
    void refresh().then((result) => {
      if (
        cancelled ||
        !result ||
        result.status !== 'applied' ||
        activeFocusWorkerHintRevisionRef.current !== normalizedFocusWorkerHintRevision ||
        selectionIntentGenerationRef.current !== generation
      ) {
        return;
      }
      // refreshWorkersSnapshot 会把 superseded 请求接到当前最新请求；只有这里拿到
      // applied 才能确认目标已出现，或最新列表已明确不含目标并允许 fallback。
      setPendingFocusWorkerSessionId(null);
      if (result.workers.some((worker) => worker.sessionId === targetSessionId)) {
        setFocusWorkerPinnedSessionId(targetSessionId);
      } else {
        setFocusWorkerPinnedSessionId(null);
      }
      window.clearTimeout(timeout);
      if (pendingFocusTimeoutRef.current === timeout) pendingFocusTimeoutRef.current = null;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (pendingFocusTimeoutRef.current === timeout) pendingFocusTimeoutRef.current = null;
    };
  }, [leadSessionId, normalizedFocusWorkerHintRevision, refresh]);

  useEffect(() => {
    if (!pendingFocusWorkerSessionId) return;
    if (workers.some((worker) => worker.sessionId === pendingFocusWorkerSessionId)) {
      // 目标已经由事件刷新/其它请求写入；取消该 intent 启动的旧 refresh/timeout，
      // 但保留 pin，避免旧异步稍后把已出现的目标清掉。
      selectionIntentGenerationRef.current += 1;
      if (pendingFocusTimeoutRef.current !== null) {
        window.clearTimeout(pendingFocusTimeoutRef.current);
        pendingFocusTimeoutRef.current = null;
      }
      setPendingFocusWorkerSessionId(null);
    }
  }, [pendingFocusWorkerSessionId, workers]);

  const selectedWorkerRecord = useMemo(() => {
    if (browseWorker) return browseWorker;
    if (effectiveSearchJumpWorkerSessionId) {
      const searchJumpWorkerRecord = workers.find(
        (w) => w.sessionId === effectiveSearchJumpWorkerSessionId,
      );
      if (searchJumpWorkerRecord) return searchJumpWorkerRecord;
    }
    if (focusWorkerHintSessionId) {
      const hintedWorkerRecord = workers.find((w) => w.sessionId === focusWorkerHintSessionId);
      if (hintedWorkerRecord) return hintedWorkerRecord;
      const shouldWaitForPendingFocusWorker =
        pendingFocusWorkerSessionId === focusWorkerHintSessionId;
      if (shouldWaitForPendingFocusWorker) return null;
    }
    if (focusedWorker) return focusedWorker;
    if (urlWorkerSessionId) {
      const explicitWorkerRecord = workers.find((w) => w.sessionId === urlWorkerSessionId);
      if (explicitWorkerRecord) return explicitWorkerRecord;
    }
    return workers[0] ?? null;
  }, [
    browseWorker,
    effectiveSearchJumpWorkerSessionId,
    focusWorkerHintSessionId,
    focusedWorker,
    pendingFocusWorkerSessionId,
    urlWorkerSessionId,
    workers,
  ]);
  const selectedWorkerId = selectedWorkerRecord?.workerId ?? null;
  const workerSessionId = selectedWorkerRecord?.sessionId ?? null;
  const editWorker = useMemo(
    () => (editWorkerId ? workers.find((w) => w.workerId === editWorkerId) ?? null : null),
    [editWorkerId, workers],
  );

  const clearSelectionHints = useCallback(() => {
    selectionIntentGenerationRef.current += 1;
    if (pendingFocusTimeoutRef.current !== null) {
      window.clearTimeout(pendingFocusTimeoutRef.current);
      pendingFocusTimeoutRef.current = null;
    }
    setSearchJumpPinnedWorkerSessionId(null);
    setFocusWorkerPinnedSessionId(null);
    setPendingFocusWorkerSessionId(null);
    onSelectionIntentCleared?.(normalizedFocusWorkerHintRevision);
  }, [normalizedFocusWorkerHintRevision, onSelectionIntentCleared]);

  const acknowledgeDoneWorker = useCallback(
    async (workerId: string): Promise<boolean> => {
      if (acknowledgingDoneWorkerIdsRef.current.has(workerId)) return false;
      acknowledgingDoneWorkerIdsRef.current.add(workerId);
      try {
        await orcaWorkflowsFor(leadSessionId).idleWorker(leadSessionId, workerId, 'done');
        clearWorkerAttention(workerId);
        return true;
      } catch (err) {
        const errorCode = extractIpcError(err)?.code;
        if (errorCode === 'WORKER_STATE_CHANGED' || errorCode === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
          log.debug('done acknowledgement skipped after worker state changed', { workerId });
          return false;
        }
        throw err;
      } finally {
        acknowledgingDoneWorkerIdsRef.current.delete(workerId);
      }
    },
    [leadSessionId],
  );

  const visibleDoneWorkerId =
    !activeBrowse && viewVisible && selectedWorkerRecord?.status === 'done' ? selectedWorkerRecord.workerId : null;

  useEffect(() => {
    if (!visibleDoneWorkerId) return;
    void acknowledgeDoneWorker(visibleDoneWorkerId)
      .then((acknowledged) => {
        if (acknowledged) return refresh();
        return undefined;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(msg);
      });
  }, [acknowledgeDoneWorker, refresh, visibleDoneWorkerId]);

  const handleCreateWorker = useCallback(
    async (form: CreateWorkerForm) => {
      const existingLabels = workers
        .map((w) => w.label)
        .filter((label): label is string => label !== null);
      const allocatedLabels = [...existingLabels];
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const label = createWorkerLabel(form.role, allocatedLabels);
        try {
          await orcaWorkflowsFor(leadSessionId).createWorker({
            leadSessionId,
            role: form.role,
            agent: form.agent,
            model: form.model,
            effort: form.effort,
            fast: form.fast,
            // null(未显式选来源)不传字段:IPC 侧只认非空 string 为显式来源。
            providerId: form.providerId ?? undefined,
            workerPermissionMode: form.workerPermissionMode,
            ...(form.executionDeviceId
              ? {
                  executionDeviceId: form.executionDeviceId,
                }
              : {}),
            ...(form.workingDir !== undefined ? {workingDir: form.workingDir} : {}),
            ...(form.worktree ? {worktree: form.worktree} : {}),
            ...(form.projectPath ? {projectPath: form.projectPath} : {}),
            // Worker 的 Agent 所在电脑(远程供应商)；面板只在任务所在电脑支持时才带。
            ...(form.agentDeviceId !== undefined ? { agentDeviceId: form.agentDeviceId } : {}),
            label,
            initialTask: form.initialTask || undefined,
          });
          setCreateOpen(false);
          await refresh();
          return;
        } catch (err) {
          if (err instanceof Error && err.message.includes('DUPLICATE_LABEL')) {
            // archived worker 不在可见列表，但 label 在 team 生命周期内永久占用。
            allocatedLabels.push(label);
            continue;
          }
          toast.error(
            (form.executionDeviceId &&
              executionDeviceErrorMessage(err, t, form.executionDeviceName, Boolean(form.workingDir)))
              || (form.agentDeviceId && workerAgentDeviceErrorMessage(err, t))
              || getCollaborationStartErrorMessage(err, t, { remoteDevice: Boolean(deviceId) }),
          );
          return;
        }
      }
      toast.error(
        getCollaborationStartErrorMessage(
          new Error('[DUPLICATE_LABEL] no unique worker label available'),
          t,
          { remoteDevice: Boolean(deviceId) },
        ),
      );
    },
    [deviceId, leadSessionId, refresh, t, workers],
  );

  const handleSwitchFocus = useCallback(
    (workerId: string, onFailure?: () => void) => {
      clearSelectionHints();
      const intent = { scope: browseScope, workerId, hintRevision: normalizedFocusWorkerHintRevision };
      latestBrowseIntent.current = intent;
      setBrowse({ intent, confirmed: false });
      const queue = focusWrites.get(browseScope) ?? { latest: intent };
      const previous = queue.tail;
      queue.latest = intent;
      const isLatest = (): boolean => queue.latest === intent && isDataOwnerGenerationCurrent(owner);
      const isVisibleIntent = () => isLatest() && visibleScope.current === browseScope &&
        latestBrowseIntent.current === intent;
      const settle = () => setBrowse((current) => current?.intent === intent ? null : current);
      const applyFocus = async () => {
        if (!isLatest()) return false;
        const workflows = deviceId ? orcaWorkflowsForDevice(deviceId) : orcaWorkflowsFor(leadSessionId);
        await workflows.switchFocus({ leadSessionId, workerIdOrLabel: workerId });
        return true;
      };
      const write = previous ? previous.catch(() => undefined).then(applyFocus) : applyFocus();
      queue.tail = write;
      focusWrites.set(browseScope, queue);
      void (async () => {
        let focusApplied = false;
        try {
          if (!(await write) || !isVisibleIntent()) return;
          focusApplied = true;
          setBrowse((current) => current?.intent === intent ? { intent, confirmed: true } : current);
          const status = workersRef.current.find((worker) => worker.workerId === workerId)?.status;
          if (visibleRef.current && status === 'done') {
            try {
              await acknowledgeDoneWorker(workerId);
            } catch (err: unknown) {
              if (isVisibleIntent()) toast.error(err instanceof Error ? err.message : String(err));
            }
          } else if (status !== 'done') {
            clearWorkerAttention(workerId);
          }
          if (isVisibleIntent()) await refresh();
        } catch (err: unknown) {
          if (isVisibleIntent()) {
            if (!focusApplied) onFailure?.();
            toast.error(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (focusWrites.get(browseScope)?.tail === write) focusWrites.delete(browseScope);
          if (visibleScope.current === browseScope && latestBrowseIntent.current === intent &&
              isDataOwnerGenerationCurrent(owner)) settle();
        }
      })();
    },
    [acknowledgeDoneWorker, browseScope, clearSelectionHints, deviceId, leadSessionId,
      normalizedFocusWorkerHintRevision, owner, refresh],
  );

  const handleArchiveWorker = useCallback(
    (workerId: string) => {
      void orcaWorkflowsFor(leadSessionId)
        .archiveWorker(leadSessionId, workerId)
        .then(() => refresh())
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(msg);
        });
    },
    [leadSessionId, refresh],
  );

  const handleOpenEditWorker = useCallback((workerId: string) => {
    setEditWorkerId(workerId);
  }, []);

  const handleCloseEditWorker = useCallback(() => {
    setEditWorkerId(null);
  }, []);

  const handleUpdateWorker = useCallback(
    async (form: EditWorkerForm): Promise<boolean> => {
      if (!editWorkerId) return false;
      // 只发用户实际改过的字段：全量提交会把期间 Lead 经 update_worker 改过的
      // role / label 静默回滚（服务端串行锁拦不住请求自带的旧值）。
      const payload: { role?: string; label?: string } = {};
      if (form.role !== undefined) payload.role = form.role.trim();
      if (form.label !== undefined) payload.label = form.label.trim();
      if (payload.role === undefined && payload.label === undefined) {
        setEditWorkerId(null);
        return true;
      }
      try {
        await orcaWorkflowsFor(leadSessionId).updateWorker({
          leadSessionId,
          workerId: editWorkerId,
          ...payload,
        });
        setEditWorkerId(null);
        await refresh();
        return true;
      } catch (err) {
        const ipcError = extractIpcError(err);
        if (ipcError?.code === 'DUPLICATE_LABEL') {
          toast.error(t('orca.editWorker.duplicateLabel', { label: payload.label ?? '' }));
        } else if (ipcError?.code === 'WORKER_STATE_CHANGED') {
          toast.error(t('orca.editWorker.labelLocked'));
        } else if (deviceId && ipcError?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
          toast.error(t('newChat.collaboration.unsupportedRemoteHint'));
        } else {
          toast.error(t('orca.editWorker.saveFailed'));
        }
        return false;
      }
    },
    [deviceId, editWorkerId, leadSessionId, refresh, t],
  );

  return {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    refreshCreationState,
    selectedWorkerRecord,
    selectedWorkerId,
    focusWritePending: Boolean(browseWorker && !activeBrowse?.confirmed),
    workerSessionId,
    createOpen,
    setCreateOpen,
    editWorker,
    handleOpenEditWorker,
    handleCloseEditWorker,
    handleUpdateWorker,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  };
}
