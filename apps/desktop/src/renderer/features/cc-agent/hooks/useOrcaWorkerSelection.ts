import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { orcaWorkflowsFor } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';
import {
  parseConversationSearchJump,
  type ConversationSearchJump,
} from '../../../../shared/conversationSearchJump';
import type { CreateWorkerForm } from '../CreateWorkerPopover';
import { getCollaborationStartErrorMessage } from '../collaborationErrors';
import { createWorkerLabel } from '../workerLabel';
import { useWorkers } from './useWorkers';
import { clearWorkerAttention } from '../lib/workerAttentionStore';

const log = createLogger('OrcaWorkerSelection');

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
    effectiveSearchJumpWorkerSessionId,
    focusWorkerHintSessionId,
    focusedWorker,
    pendingFocusWorkerSessionId,
    urlWorkerSessionId,
    workers,
  ]);
  const selectedWorkerId = selectedWorkerRecord?.workerId ?? null;
  const workerSessionId = selectedWorkerRecord?.sessionId ?? null;

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
    viewVisible && selectedWorkerRecord?.status === 'done' ? selectedWorkerRecord.workerId : null;

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
            getCollaborationStartErrorMessage(err, t, { remoteDevice: Boolean(deviceId) }),
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
    (workerId: string) => {
      clearSelectionHints();
      const worker = workersRef.current.find((item) => item.workerId === workerId);
      const acknowledgeDone = worker?.status === 'done';
      void (async () => {
        try {
          const workflows = orcaWorkflowsFor(leadSessionId);
          await workflows.switchFocus({
            leadSessionId,
            workerIdOrLabel: workerId,
          });
          let acknowledged = false;
          if (acknowledgeDone) {
            try {
              acknowledged = await acknowledgeDoneWorker(workerId);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              toast.error(msg);
            }
          }
          if (!acknowledgeDone || acknowledged) clearWorkerAttention(workerId);
          await refresh();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(msg);
        }
      })();
    },
    [acknowledgeDoneWorker, clearSelectionHints, leadSessionId, refresh],
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
    workerSessionId,
    createOpen,
    setCreateOpen,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  };
}
