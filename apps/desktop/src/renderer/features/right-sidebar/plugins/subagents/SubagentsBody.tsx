/**
 * SubagentsBody — data orchestration for the durable Subagent workspace tab.
 *
 * This file owns *only* reads, writes and ownership fencing; every pixel lives
 * in `RunList.tsx` / `DetailView.tsx` and their children.
 *
 * Invariants that must not be weakened:
 *  - `subagentReadScopeKey` remounts the stateful reader at every ownership
 *    boundary, so data from a previous task/account is never painted while the
 *    replacement IPC request is in flight.
 *  - Every response is dropped unless `isCurrentSubagentReadOwner` still holds
 *    for the generation that issued it, and change pushes are filtered through
 *    `isCurrentSubagentRunsChange`.
 *  - All four reads/writes (list / detail / transcript / control) have a
 *    device-link branch: a sticky remote task must read from the data-owning
 *    device, and remote PI stop goes through the PI-only control channel.
 *
 * Transcript loading: the conversation is the primary content now, so the
 * transcript is paged in eagerly on entering a detail (loop `nextCursor` up to
 * a page bound), and every later change event resumes from `tailCursor` and
 * appends only what was written since. That keeps the 1s remote poll from
 * re-reading a record that may grow to the 50MB storage cap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Bot, LoaderCircle, RefreshCw } from 'lucide-react';
import type {
  SubagentProvider,
  SubagentRun,
  SubagentRunDetail,
  SubagentRunDetailResponse,
  SubagentRunsListResponse,
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { TabKindHostContext } from '../../types';
import type { SubagentsState } from './index';
import { DetailView, type SubagentControlIntent } from './DetailView';
import { RunList } from './RunList';
import { CenteredState } from './SubagentChrome';
import { runMatchesSelection } from './subagentFormat';
import {
  isCurrentSubagentReadOwner,
  isCurrentSubagentRunsChange,
  subagentReadScopeKey,
} from './subagentChangeFence';

type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

/** Host clamps the page size; 200 is its maximum. */
const TRANSCRIPT_PAGE_SIZE = 200;
/**
 * Bound on the eager paging loop. A record long enough to exceed this keeps its
 * `nextCursor`, so the technical-details "load more" button stays available.
 */
const MAX_TRANSCRIPT_PAGES = 100;

interface SubagentsBodyProps {
  state: SubagentsState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}

export function SubagentsBody(props: SubagentsBodyProps) {
  const owner = getDataOwnerGeneration();
  // A tab host can survive task/account switches. Remount the stateful reader
  // at every ownership boundary so data from the previous scope is never
  // painted while the replacement IPC request is in flight.
  const scopeKey = subagentReadScopeKey(
    owner,
    props.ctx.sessionId,
    props.ctx.deviceLinkDeviceId,
    props.ctx.remoteHostId,
  );
  return <ScopedSubagentsBody key={scopeKey} {...props} />;
}

function ScopedSubagentsBody({
  state,
  ctx,
  active = true,
  shellVisible = true,
}: SubagentsBodyProps) {
  const { t } = useTranslation();
  const visible = active && shellVisible;
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<SubagentRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRefreshVersion, setDetailRefreshVersion] = useState(0);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SubagentTranscriptEntry[]>([]);
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptForRunId, setTranscriptForRunId] = useState<string | null>(null);
  const [transcriptRefreshVersion, setTranscriptRefreshVersion] = useState(0);
  const transcriptTargetRef = useRef<string | null>(null);
  /** Byte offset the last read stopped at; the resume point for tail reads. */
  const transcriptTailRef = useRef<string | null>(null);
  /** Refresh version already consumed, so one push causes exactly one read. */
  const transcriptSyncedVersionRef = useRef<number>(-1);
  const selectedProviderHint = state.selectedProvider === 'pi' ? 'pi' : null;
  const selectedRunAlias = state.selectedProvider && state.selectedProvider !== 'pi'
    ? null
    : (state.selectedRunId ?? null);
  const remoteDevice = ctx.deviceLinkDeviceId !== null;

  // Product surface is Pi-only. Claude Code/Codex collection remains an
  // internal compatibility layer and never participates in UI selection.
  const selectedProvider: SubagentProvider | null = selectedRunAlias ? 'pi' : null;
  const selectedDetail = detail && runMatchesSelection(detail, selectedProvider, selectedRunAlias)
    ? detail
    : null;

  const loadRuns = useCallback(
    async (cursor?: string) => {
      const append = Boolean(cursor);
      const requestOwner = getDataOwnerGeneration();
      if (append) setLoadingMore(true);
      else setLoadState((current) => (current === 'ready' ? current : 'loading'));
      try {
        const input = { sessionId: ctx.sessionId, ...(cursor ? { cursor } : {}) };
        const response = remoteDevice
          ? await window.electronAPI.deviceLink.invoke(
              ctx.deviceLinkDeviceId!,
              'local-db:subagent-runs:list',
              [input],
            ) as SubagentRunsListResponse
          : await window.electronAPI.localDb.subagentRuns.list(input);
        if (!isCurrentSubagentReadOwner(requestOwner)) return;
        if (!response.supported) {
          setRuns([]);
          setNextCursor(null);
          setLoadState('unsupported');
          return;
        }
        const visibleRuns = response.runs.filter((run) => run.provider === 'pi');
        setRuns((current) => {
          if (!append) return visibleRuns;
          const byId = new Map(current.map((run) => [run.id, run]));
          for (const run of visibleRuns) byId.set(run.id, run);
          return [...byId.values()];
        });
        setNextCursor(response.nextCursor ?? null);
        setLoadState('ready');
      } catch {
        if (isCurrentSubagentReadOwner(requestOwner) && !append) setLoadState('error');
      } finally {
        if (isCurrentSubagentReadOwner(requestOwner) && append) setLoadingMore(false);
      }
    },
    [ctx.deviceLinkDeviceId, ctx.sessionId, remoteDevice],
  );

  useEffect(() => {
    if (!visible) return;
    void loadRuns();
    if (remoteDevice) {
      const poll = setInterval(() => {
        void loadRuns();
        setDetailRefreshVersion((version) => version + 1);
        setTranscriptRefreshVersion((version) => version + 1);
      }, 1000);
      return () => clearInterval(poll);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.electronAPI.localDb.subagentRuns.onChanged((payload, ownerStamp) => {
      if (!isCurrentSubagentRunsChange(payload, ownerStamp, ctx.sessionId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadRuns();
        setDetailRefreshVersion((version) => version + 1);
        setTranscriptRefreshVersion((version) => version + 1);
      }, 50);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [ctx.sessionId, loadRuns, remoteDevice, visible]);

  useEffect(() => {
    if (
      !visible
      || !selectedRunAlias
      || !selectedProvider
      || loadState === 'unsupported'
    ) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let disposed = false;
    const requestOwner = getDataOwnerGeneration();
    setDetailLoading(true);
    const input = {
      sessionId: ctx.sessionId,
      provider: selectedProvider,
      runIdOrAlias: selectedRunAlias,
    };
    const request = remoteDevice
      ? window.electronAPI.deviceLink.invoke(
          ctx.deviceLinkDeviceId!,
          'local-db:subagent-runs:detail',
          [input],
        ) as Promise<SubagentRunDetailResponse>
      : window.electronAPI.localDb.subagentRuns.detail(input);
    void request.then((response) => {
        if (disposed || !isCurrentSubagentReadOwner(requestOwner)) return;
        setDetail(response.supported ? response.run : null);
        if (
          response.run
          && (response.run.id !== selectedRunAlias || response.run.provider !== selectedProviderHint)
        ) {
          ctx.patchState({
            selectedRunId: response.run.id,
            selectedProvider: response.run.provider,
          });
        }
      })
      .catch(() => {
        if (!disposed && isCurrentSubagentReadOwner(requestOwner)) setDetail(null);
      })
      .finally(() => {
        if (!disposed && isCurrentSubagentReadOwner(requestOwner)) setDetailLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    ctx,
    detailRefreshVersion,
    loadState,
    selectedProvider,
    selectedProviderHint,
    selectedRunAlias,
    remoteDevice,
    visible,
  ]);

  const fetchTranscriptPage = useCallback(
    async (run: SubagentRunDetail, cursor?: string): Promise<SubagentTranscriptPageResponse> => {
      const input = {
        sessionId: ctx.sessionId,
        provider: run.provider,
        runIdOrAlias: run.id,
        limit: TRANSCRIPT_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      };
      return remoteDevice
        ? await window.electronAPI.deviceLink.invoke(
            ctx.deviceLinkDeviceId!,
            'local-db:subagent-runs:transcript',
            [input],
          ) as SubagentTranscriptPageResponse
        : await window.electronAPI.localDb.subagentRuns.transcript(input);
    },
    [ctx.deviceLinkDeviceId, ctx.sessionId, remoteDevice],
  );

  /**
   * Read the transcript for `run`. Without a cursor this is a full read that
   * replaces the current entries; with one it is an append-only tail read.
   * Entries are merged by id so an overlapping page can never duplicate a row.
   */
  const loadTranscript = useCallback(
    async (run: SubagentRunDetail, fromCursor?: string) => {
      const requestOwner = getDataOwnerGeneration();
      const targetRunId = run.id;
      const append = fromCursor !== undefined;
      transcriptTargetRef.current = targetRunId;
      setTranscriptLoading(true);
      try {
        let cursor = fromCursor;
        let tail: string | null = append ? fromCursor ?? null : null;
        const collected: SubagentTranscriptEntry[] = [];
        for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
          const response = await fetchTranscriptPage(run, cursor);
          if (
            !isCurrentSubagentReadOwner(requestOwner)
            || transcriptTargetRef.current !== targetRunId
          ) return;
          if (!response.supported) {
            if (!append) {
              setTranscript([]);
              setTranscriptCursor(null);
              transcriptTailRef.current = null;
            }
            return;
          }
          collected.push(...response.entries);
          tail = response.tailCursor ?? response.nextCursor ?? tail;
          cursor = response.nextCursor;
          if (!cursor) break;
        }
        transcriptTailRef.current = tail;
        setTranscriptCursor(cursor ?? null);
        setTranscript((current) => {
          if (!append) return collected;
          if (collected.length === 0) return current;
          const seen = new Set(current.map((entry) => entry.id));
          const added = collected.filter((entry) => !seen.has(entry.id));
          return added.length > 0 ? [...current, ...added] : current;
        });
      } catch {
        if (
          !isCurrentSubagentReadOwner(requestOwner)
          || transcriptTargetRef.current !== targetRunId
        ) return;
        // A tail read can fail on a cursor the host now rejects (the record was
        // rewritten, so the offset is past its end). Drop the cursor instead of
        // keeping it: the refresh version is already consumed, so retrying the
        // same bad cursor on every later change would silently freeze the
        // conversation. Clearing it makes the next change do a full read.
        transcriptTailRef.current = null;
        if (!append) {
          setTranscript([]);
          setTranscriptCursor(null);
        }
      } finally {
        if (
          isCurrentSubagentReadOwner(requestOwner)
          && transcriptTargetRef.current === targetRunId
        ) setTranscriptLoading(false);
      }
    },
    [fetchTranscriptPage],
  );

  useEffect(() => {
    if (!visible || !detail?.capabilities.viewFullTranscript) {
      transcriptTargetRef.current = null;
      transcriptTailRef.current = null;
      setTranscript([]);
      setTranscriptCursor(null);
      setTranscriptForRunId(null);
      setTranscriptLoading(false);
      return;
    }
    if (transcriptForRunId !== detail.id) {
      // Entering a detail (or re-reading after a control landed): full page-in.
      transcriptTailRef.current = null;
      transcriptSyncedVersionRef.current = transcriptRefreshVersion;
      setTranscript([]);
      setTranscriptCursor(null);
      setTranscriptForRunId(detail.id);
      void loadTranscript(detail);
      return;
    }
    if (transcriptSyncedVersionRef.current === transcriptRefreshVersion) return;
    transcriptSyncedVersionRef.current = transcriptRefreshVersion;
    // A durable change landed. Resume from the byte we stopped at when the host
    // reported one; older hosts omit `tailCursor`, so fall back to a full read.
    void loadTranscript(detail, transcriptTailRef.current ?? undefined);
  }, [detail, loadTranscript, transcriptForRunId, transcriptRefreshVersion, visible]);

  const openRun = useCallback(
    (run: SubagentRun) => ctx.patchState({
      selectedRunId: run.id,
      selectedProvider: run.provider,
    }),
    [ctx],
  );
  const back = useCallback(
    () => ctx.patchState({ selectedRunId: null, selectedProvider: null }),
    [ctx],
  );
  const controlRun = useCallback(
    async (
      run: SubagentRunDetail,
      action: SubagentControlIntent,
      message: string,
      childId?: string,
    ): Promise<boolean> => {
      const api = window.electronAPI?.maker;
      const allowed = action === 'resume'
        ? run.capabilities.resume && run.status !== 'running'
        : run.capabilities.steer && run.status === 'running';
      if (run.provider !== 'pi' || !allowed || !api?.controlPiSubagent) return false;
      const taskId = run.parentToolUseId ?? run.logicalAgentId;
      const input = {
        sessionId: ctx.sessionId,
        taskId,
        action,
        message,
        ...(childId ? { childId } : {}),
      };
      try {
        const result = remoteDevice
          ? await window.electronAPI.deviceLink.invoke(
              ctx.deviceLinkDeviceId!,
              'maker:pi-subagent:control',
              [input],
            ) as { ok: boolean; controlled: number }
          : await api.controlPiSubagent(input);
        if (result.ok) {
          setTranscriptForRunId(null);
          setDetailRefreshVersion((version) => version + 1);
        }
        return result.ok;
      } catch {
        return false;
      }
    },
    [ctx.deviceLinkDeviceId, ctx.sessionId, remoteDevice],
  );

  const stopRun = useCallback(
    (run: SubagentRunDetail, childId?: string) => {
      const api = window.electronAPI?.maker;
      if (!run.capabilities.stop || run.status !== 'running' || !api?.stopAgentTask) return;
      const controlTaskId = run.provider === 'pi'
        ? run.parentToolUseId ?? run.logicalAgentId
        : run.logicalAgentId;
      setStoppingRunId(run.id);
      const request = remoteDevice
        ? run.provider === 'pi'
          ? window.electronAPI.deviceLink.invoke(
              ctx.deviceLinkDeviceId!,
              'maker:pi-subagent:control',
              [{
                sessionId: ctx.sessionId,
                taskId: controlTaskId,
                action: 'stop',
                ...(childId ? { childId } : {}),
              }],
            )
          : Promise.reject(new Error('Remote stop is only supported for PI Subagents'))
        : childId && run.provider === 'pi' && api.controlPiSubagent
          ? api.controlPiSubagent({
              sessionId: ctx.sessionId,
              taskId: controlTaskId,
              action: 'stop',
              childId,
            })
          : api.stopAgentTask(ctx.sessionId, controlTaskId);
      void request
        .catch(() => {
          // Keep the durable status as the source of truth. A failed request
          // leaves the run visible and retryable instead of painting it stopped.
        })
        .finally(() => setStoppingRunId((current) => (current === run.id ? null : current)));
    },
    [ctx.deviceLinkDeviceId, ctx.sessionId, remoteDevice],
  );

  const loadMoreTranscript = useCallback(() => {
    if (selectedDetail && transcriptCursor) void loadTranscript(selectedDetail, transcriptCursor);
  }, [loadTranscript, selectedDetail, transcriptCursor]);

  const detailKey = useMemo(
    () => `${selectedDetail?.provider ?? selectedProvider ?? 'unknown'}:${selectedDetail?.id ?? selectedRunAlias}`,
    [selectedDetail, selectedProvider, selectedRunAlias],
  );

  if (loadState === 'idle' || loadState === 'loading') {
    return (
      <CenteredState icon={LoaderCircle} spinning label={t('rightSidebar.subagents.loading')} />
    );
  }
  if (loadState === 'unsupported') {
    return (
      <CenteredState
        icon={Bot}
        label={t('rightSidebar.subagents.unavailable')}
        detail={t('rightSidebar.subagents.unavailableDetail')}
      />
    );
  }
  if (selectedRunAlias) {
    return (
      <DetailView
        key={detailKey}
        detail={selectedDetail}
        loading={detailLoading || selectedDetail === null}
        workdir={ctx.workdir}
        allowPrivilegedLinks={ctx.deviceLinkDeviceId === null && !ctx.remoteHostId}
        stopping={selectedDetail !== null && stoppingRunId === selectedDetail.id}
        transcript={transcript}
        transcriptLoading={transcriptLoading}
        transcriptCursor={transcriptCursor}
        onLoadMoreTranscript={loadMoreTranscript}
        onBack={back}
        onStop={stopRun}
        onControl={controlRun}
      />
    );
  }
  if (loadState === 'error') {
    return (
      <CenteredState
        icon={AlertCircle}
        label={t('rightSidebar.subagents.loadFailed')}
        action={
          <button
            type="button"
            onClick={() => void loadRuns()}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <RefreshCw size={13} aria-hidden="true" />
            {t('rightSidebar.subagents.retry')}
          </button>
        }
      />
    );
  }
  if (runs.length === 0) {
    return (
      <CenteredState
        icon={Bot}
        label={t('rightSidebar.subagents.empty')}
        detail={t('rightSidebar.subagents.emptyDetail')}
      />
    );
  }

  return (
    <RunList
      runs={runs}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      onOpen={openRun}
      onLoadMore={() => {
        if (nextCursor) void loadRuns(nextCursor);
      }}
    />
  );
}
