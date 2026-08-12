import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type {
  SubagentActivityEntry,
  SubagentProvider,
  SubagentRun,
  SubagentRunDetail,
} from '@cindy/maker-shared/subagent-workspace';

import { TranscriptSection } from './TranscriptSection';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import type { TabKindHostContext } from '../../types';
import type { SubagentsState } from './index';
import {
  isCurrentSubagentReadOwner,
  isCurrentSubagentRunsChange,
  subagentReadScopeKey,
} from './subagentChangeFence';

type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

function statusIcon(status: SubagentRun['status']): LucideIcon {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

function providerLabel(provider: SubagentProvider): string {
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  return 'PI';
}

function runPrimaryLabel(run: SubagentRun, fallback: string): string {
  return run.title?.trim() || run.description?.trim() || fallback;
}

function runProgressLabel(run: SubagentRun, fallback: string): string {
  return run.summary?.trim() || run.description?.trim() || fallback;
}

function StatusGlyph({ status, label }: { status: SubagentRun['status']; label: string }) {
  const Icon = statusIcon(status);
  return (
    <Spinner
      icon={Icon}
      size={14}
      spinning={status === 'running'}
      aria-label={label}
      title={label}
      className={cn('text-[var(--text-tertiary)]', status === 'failed' && 'text-[var(--error-fg)]')}
    />
  );
}

function StopButton({
  run,
  stopping,
  onStop,
}: {
  run: SubagentRun;
  stopping: boolean;
  onStop: (run: SubagentRun) => void;
}) {
  const { t } = useTranslation();
  if (run.status !== 'running' || !run.capabilities.stop) return null;
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={(event) => {
        event.stopPropagation();
        onStop(run);
      }}
      title={t('rightSidebar.subagents.stop')}
      aria-label={t('rightSidebar.subagents.stop')}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <Spinner icon={Square} spinning={stopping} size={13} />
    </button>
  );
}

function RunRow({
  run,
  stopping,
  onOpen,
  onStop,
}: {
  run: SubagentRun;
  stopping: boolean;
  onOpen: (run: SubagentRun) => void;
  onStop: (run: SubagentRun) => void;
}) {
  const { t } = useTranslation();
  const primary = runPrimaryLabel(run, t('rightSidebar.subagents.untitled'));
  const progress = runProgressLabel(run, t(`chat.agentTask.status.${run.status}`));
  const statusLabel = t(`chat.agentTask.status.${run.status}`);
  return (
    <div className="group flex h-14 w-full items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--surface-hover)]">
      <button
        type="button"
        onClick={() => onOpen(run)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
          <StatusGlyph status={run.status} label={statusLabel} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
            {primary}
          </span>
          <span className="block truncate text-11 leading-4 text-[var(--text-tertiary)]">
            {progress}
          </span>
        </span>
      </button>
      <StopButton run={run} stopping={stopping} onStop={onStop} />
      <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
    </div>
  );
}

function ActivityRow({ entry }: { entry: SubagentActivityEntry }) {
  const { t } = useTranslation();
  const label = t(`rightSidebar.subagents.activityKinds.${entry.kind}`);
  return (
    <div className="relative flex gap-2 pb-3 pl-1 last:pb-0">
      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--border-strong)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 font-medium text-[var(--text-secondary)]">{label}</span>
          <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
            {new Date(entry.occurredAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        {entry.summary ? (
          <p className="mt-0.5 whitespace-pre-wrap text-12 leading-4 text-[var(--text-tertiary)]">
            {entry.summary}
          </p>
        ) : null}
        {entry.lastToolName ? (
          <p className="mt-0.5 truncate text-11 text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.lastTool', { tool: entry.lastToolName })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DetailView({
  detail,
  loading,
  workdir,
  allowPrivilegedLinks,
  stopping,
  onStop,
  onBack,
}: {
  detail: SubagentRunDetail | null;
  loading: boolean;
  workdir: string;
  allowPrivilegedLinks: boolean;
  stopping: boolean;
  onStop: (run: SubagentRun) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  if (loading && !detail) {
    return (
      <CenteredState icon={LoaderCircle} spinning label={t('rightSidebar.subagents.loading')} />
    );
  }
  if (!detail) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <HeaderBack onBack={onBack} title={t('rightSidebar.subagents.notFound')} />
      </div>
    );
  }
  const title = runPrimaryLabel(detail, t('rightSidebar.subagents.untitled'));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HeaderBack
        onBack={onBack}
        title={title}
        status={detail.status}
        action={<StopButton run={detail} stopping={stopping} onStop={onStop} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-12">
          <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.subagents.harness')}</dt>
          <dd className="truncate text-[var(--text-secondary)]">
            {providerLabel(detail.provider)}
          </dd>
          {detail.model ? (
            <>
              <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.subagents.model')}</dt>
              <dd className="truncate text-[var(--text-secondary)]">{detail.model}</dd>
            </>
          ) : null}
          <dt className="text-[var(--text-tertiary)]">{t('rightSidebar.subagents.context')}</dt>
          <dd className="text-[var(--text-secondary)]">
            {t(`rightSidebar.subagents.contextValues.${detail.capabilities.parentContext}`)}
          </dd>
        </dl>

        <TranscriptSection
          sessionId={detail.parentSessionId}
          provider={detail.provider}
          runId={detail.id}
          supported={detail.capabilities.viewFullTranscript}
          workdir={workdir}
          allowPrivilegedLinks={allowPrivilegedLinks}
          refreshKey={detail.updatedAt}
        />

        {!detail.capabilities.viewFullTranscript &&
        detail.capabilities.viewReturnedResult &&
        detail.returnedResult ? (
          <section className="mt-5">
            <SectionTitle>{t('rightSidebar.subagents.returnedResult')}</SectionTitle>
            <div className="text-13 leading-5 text-[var(--text-primary)]">
              <MarkdownRenderer
                workingDir={workdir}
                content={detail.returnedResult}
                allowPrivilegedLinks={allowPrivilegedLinks}
              />
            </div>
            {detail.returnedResultTruncated ? (
              <p className="mt-2 text-11 text-[var(--text-tertiary)]">
                {t('rightSidebar.subagents.resultTruncated')}
              </p>
            ) : null}
          </section>
        ) : detail.summary ? (
          <section className="mt-5">
            <SectionTitle>{t('rightSidebar.subagents.latestUpdate')}</SectionTitle>
            <p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-secondary)]">
              {detail.summary}
            </p>
          </section>
        ) : null}

        {detail.capabilities.viewActivity ? (
          <details className="mt-5 border-t border-[var(--border-default)] pt-3">
            <summary className="cursor-pointer select-none text-11 font-medium text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.activity')}
            </summary>
            {detail.activity.length > 0 ? (
              <div className="mt-3">
                {detail.activity.map((entry) => (
                  <ActivityRow key={entry.sequence} entry={entry} />
                ))}
              </div>
            ) : (
              <p className="text-12 text-[var(--text-tertiary)]">
                {t('rightSidebar.subagents.noActivity')}
              </p>
            )}
          </details>
        ) : null}
      </div>
    </div>
  );
}

function HeaderBack({
  onBack,
  title,
  status,
  action,
}: {
  onBack: () => void;
  title: string;
  status?: SubagentRun['status'];
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
      <button
        type="button"
        onClick={onBack}
        title={t('rightSidebar.subagents.back')}
        aria-label={t('rightSidebar.subagents.back')}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ArrowLeft size={15} aria-hidden="true" />
      </button>
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
        {title}
      </span>
      {action}
      {status ? <StatusGlyph status={status} label={t(`chat.agentTask.status.${status}`)} /> : null}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
      {children}
    </h3>
  );
}

function CenteredState({
  icon: Icon,
  label,
  detail,
  spinning = false,
  action,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  spinning?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
      <Spinner icon={Icon} spinning={spinning} size={20} className="text-[var(--text-tertiary)]" />
      <p className="mt-3 text-13 font-medium text-[var(--text-secondary)]">{label}</p>
      {detail ? (
        <p className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">{detail}</p>
      ) : null}
      {action}
    </div>
  );
}

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
  const selectedRunAlias = state.selectedRunId ?? null;
  const selectedProviderHint = state.selectedProvider ?? null;
  const remoteDevice = ctx.deviceLinkDeviceId !== null;

  // New focus entrances always carry the harness. Old persisted tab state may
  // not; infer it only when the loaded page identifies one unambiguous
  // provider. Alias-to-run resolution itself remains host-owned and scoped by
  // (session, provider, alias), so a same-named run in another harness cannot
  // win because it happened to update later.
  const selectedProvider = useMemo(() => {
    if (!selectedRunAlias) return null;
    if (selectedProviderHint) return selectedProviderHint;
    const exact = runs.find((run) => run.id === selectedRunAlias);
    if (exact) return exact.provider;
    const matches = runs.filter(
      (run) =>
        run.logicalAgentId === selectedRunAlias ||
        run.parentToolUseId === selectedRunAlias ||
        run.identityAliases.includes(selectedRunAlias) ||
        run.providerRunIds.includes(selectedRunAlias),
    );
    const providers = new Set(matches.map((run) => run.provider));
    return providers.size === 1 ? (matches[0]?.provider ?? null) : null;
  }, [runs, selectedProviderHint, selectedRunAlias]);

  const loadRuns = useCallback(
    async (cursor?: string) => {
      const append = Boolean(cursor);
      const requestOwner = getDataOwnerGeneration();
      if (remoteDevice) {
        setLoadState('unsupported');
        setRuns([]);
        setNextCursor(null);
        return;
      }
      if (append) setLoadingMore(true);
      else setLoadState((current) => (current === 'ready' ? current : 'loading'));
      try {
        const response = await window.electronAPI.localDb.subagentRuns.list({
          sessionId: ctx.sessionId,
          ...(cursor ? { cursor } : {}),
        });
        if (!isCurrentSubagentReadOwner(requestOwner)) return;
        if (!response.supported) {
          setRuns([]);
          setNextCursor(null);
          setLoadState('unsupported');
          return;
        }
        setRuns((current) => {
          if (!append) return response.runs;
          const byId = new Map(current.map((run) => [run.id, run]));
          for (const run of response.runs) byId.set(run.id, run);
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
    [ctx.sessionId, remoteDevice],
  );

  useEffect(() => {
    if (!visible) return;
    void loadRuns();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.electronAPI.localDb.subagentRuns.onChanged((payload, ownerStamp) => {
      if (!isCurrentSubagentRunsChange(payload, ownerStamp, ctx.sessionId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadRuns();
        setDetailRefreshVersion((version) => version + 1);
      }, 50);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [ctx.sessionId, loadRuns, visible]);

  useEffect(() => {
    if (!visible || !selectedRunAlias || !selectedProvider || loadState === 'unsupported') {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let disposed = false;
    const requestOwner = getDataOwnerGeneration();
    setDetailLoading(true);
    void window.electronAPI.localDb.subagentRuns
      .detail({
        sessionId: ctx.sessionId,
        provider: selectedProvider,
        runIdOrAlias: selectedRunAlias,
      })
      .then((response) => {
        if (disposed || !isCurrentSubagentReadOwner(requestOwner)) return;
        setDetail(response.supported ? response.run : null);
        if (
          response.run &&
          (response.run.id !== selectedRunAlias || response.run.provider !== selectedProviderHint)
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
    visible,
  ]);

  const grouped = useMemo(
    () => ({
      running: runs.filter((run) => run.status === 'running'),
      finished: runs.filter((run) => run.status !== 'running'),
    }),
    [runs],
  );

  const openRun = useCallback(
    (run: SubagentRun) =>
      ctx.patchState({
        selectedRunId: run.id,
        selectedProvider: run.provider,
      }),
    [ctx],
  );
  const back = useCallback(
    () => ctx.patchState({ selectedRunId: null, selectedProvider: null }),
    [ctx],
  );
  const stopRun = useCallback(
    async (run: SubagentRun) => {
      if (run.status !== 'running' || !run.capabilities.stop || stoppingRunId) return;
      setStoppingRunId(run.id);
      try {
        await window.electronAPI.maker.stopAgentTask(ctx.sessionId, run.logicalAgentId);
      } finally {
        setStoppingRunId(null);
      }
    },
    [ctx.sessionId, stoppingRunId],
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
        detail={detail}
        loading={detailLoading}
        workdir={ctx.workdir}
        allowPrivilegedLinks={ctx.deviceLinkDeviceId === null && !ctx.remoteHostId}
        stopping={detail?.id === stoppingRunId}
        onStop={(run) => void stopRun(run)}
        onBack={back}
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
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-4">
        <Bot size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
        <h2 className="text-13 font-medium text-[var(--text-primary)]">
          {t('rightSidebar.tabs.kinds.subagents')}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {grouped.running.length > 0 ? (
          <section>
            <div className="px-2 pb-1 pt-1 text-10 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.running')}
            </div>
            {grouped.running.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                stopping={run.id === stoppingRunId}
                onOpen={openRun}
                onStop={(item) => void stopRun(item)}
              />
            ))}
          </section>
        ) : null}
        {grouped.finished.length > 0 ? (
          <section className={grouped.running.length > 0 ? 'mt-3' : undefined}>
            <div className="px-2 pb-1 pt-1 text-10 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.finished')}
            </div>
            {grouped.finished.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                stopping={run.id === stoppingRunId}
                onOpen={openRun}
                onStop={(item) => void stopRun(item)}
              />
            ))}
          </section>
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadRuns(nextCursor)}
            className="mx-2 mt-3 flex h-8 items-center justify-center rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {loadingMore
              ? t('rightSidebar.subagents.loading')
              : t('rightSidebar.subagents.loadEarlier')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
