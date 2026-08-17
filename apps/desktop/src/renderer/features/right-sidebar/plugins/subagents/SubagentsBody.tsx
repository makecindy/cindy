import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  SendHorizontal,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type {
  SubagentActivityEntry,
  SubagentChildRun,
  SubagentProvider,
  SubagentRun,
  SubagentRunDetail,
  SubagentRunDetailResponse,
  SubagentRunUsage,
  SubagentRunsListResponse,
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { AssistantMessage } from '@/components/chat/AssistantMessage';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { UserMessage } from '@/components/chat/UserMessage';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  getComposerSendShortcutLabel,
  resolveComposerEnterIntent,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { cn } from '@/lib/utils';
import { formatCompactTokens } from '@/lib/usageFormat';
import type { TabKindHostContext } from '../../types';
import type { SubagentsState } from './index';
import {
  isCurrentSubagentReadOwner,
  isCurrentSubagentRunsChange,
  subagentReadScopeKey,
} from './subagentChangeFence';

type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

function statusIcon(status: SubagentRun['status'] | 'queued'): LucideIcon {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function providerLabel(provider: SubagentProvider): string {
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  // 轮 33 C2:'PI' → 'Pi'(与全产品命名一致)。
  return 'Pi';
}

function runTitle(run: SubagentRun, fallback: string): string {
  return run.title?.trim() || run.description?.trim() || fallback;
}

function runMatchesSelection(
  run: SubagentRunDetail,
  provider: SubagentProvider | null,
  alias: string | null,
): boolean {
  if (!provider || !alias || run.provider !== provider) return false;
  return run.id === alias
    || run.logicalAgentId === alias
    || run.parentToolUseId === alias
    || run.identityAliases.includes(alias)
    || run.providerRunIds.includes(alias);
}

function usageMetadata(
  usage: SubagentRunUsage | undefined,
  t: TFunction,
  options: { includeCost?: boolean } = {},
): string[] {
  const parts: string[] = [];
  const duration = formatDuration(usage?.durationMs);
  if (duration) parts.push(duration);
  if (typeof usage?.totalTokens === 'number' && usage.totalTokens > 0) {
    parts.push(
      t('rightSidebar.subagents.tokens', {
        value: formatCompactTokens(usage.totalTokens),
      }),
    );
  }
  if (typeof usage?.toolUses === 'number' && usage.toolUses > 0) {
    parts.push(t('rightSidebar.subagents.toolUses', { count: usage.toolUses }));
  }
  if (options.includeCost && typeof usage?.costUsd === 'number' && usage.costUsd > 0) {
    parts.push(usage.costUsd < 0.01 ? '<$0.01' : `$${usage.costUsd.toFixed(2)}`);
  }
  return parts;
}

function metadata(run: SubagentRun, t: TFunction): string[] {
  return [
    providerLabel(run.provider),
    ...(run.model ? [run.model] : []),
    ...usageMetadata(run.usage, t, { includeCost: run.provider === 'pi' }),
  ];
}

function childMetadata(child: SubagentChildRun, t: TFunction): string[] {
  return [
    child.role,
    ...(child.model ? [child.model] : []),
    ...(child.reasoningEffort ? [child.reasoningEffort] : []),
    ...usageMetadata(child.usage, t, { includeCost: true }),
  ];
}

type SubagentErrorKind =
  | 'providerNotConnected'
  | 'credentialInvalid'
  | 'modelInvalid'
  | 'rateLimited'
  | 'serviceUnavailable'
  | 'requestInvalid'
  | 'unknown';

function classifySubagentError(rawError: string): SubagentErrorKind {
  const value = rawError.toLowerCase();
  if (
    /invalid model|model[^\n]{0,80}(?:not found|unknown|unsupported|unavailable)|unknown[^\n]{0,40}model/.test(value)
  ) return 'modelInvalid';
  if (
    /(?:status(?:code)?\s*[:=]?\s*)?401\b|unauthori[sz]ed|invalid api[- ]?key|invalid[^\n]{0,40}token|token[^\n]{0,40}(?:expired|revoked)|credential[^\n]{0,40}(?:expired|invalid|revoked)/.test(value)
  ) return 'credentialInvalid';
  if (
    /provider[^\n]{0,60}(?:not connected|not configured|unavailable)|(?:missing|no)[^\n]{0,40}(?:credential|api[- ]?key|token)|authentication required|sign[- ]?in required|please[^\n]{0,40}(?:connect|sign in)/.test(value)
  ) return 'providerNotConnected';
  if (/(?:status(?:code)?\s*[:=]?\s*)?429\b|rate[- ]?limit|too many requests/.test(value)) {
    return 'rateLimited';
  }
  if (
    /(?:status(?:code)?\s*[:=]?\s*)?(?:500|502|503|504)\b|service unavailable|bad gateway|gateway timeout|temporarily unavailable/.test(value)
  ) return 'serviceUnavailable';
  if (/(?:status(?:code)?\s*[:=]?\s*)?400\b|bad request|invalid request/.test(value)) {
    return 'requestInvalid';
  }
  return 'unknown';
}

function SubagentErrorNotice({ rawError }: { rawError: string }) {
  const { t } = useTranslation();
  const kind = classifySubagentError(rawError);
  return (
    <div
      data-subagent-error-kind={kind}
      className="rounded-[10px] border border-[color-mix(in_srgb,var(--error-fg)_28%,var(--border-default))] bg-[color-mix(in_srgb,var(--error-fg)_7%,var(--surface-elevated))] px-3 py-2.5"
    >
      <div className="flex items-start gap-2 text-13 leading-5 text-[var(--error-fg)]">
        <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t(`rightSidebar.subagents.errors.${kind}`)}</span>
      </div>
      <details className="mt-2 text-11 text-[var(--text-tertiary)]">
        <summary className="w-fit cursor-pointer rounded-[4px] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {t('rightSidebar.subagents.errors.rawDetails')}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--surface-chip)] p-2 font-mono text-11 leading-4 text-[var(--text-secondary)]">
          {rawError}
        </pre>
      </details>
    </div>
  );
}

function StatusGlyph({ status, label }: { status: SubagentRun['status'] | 'queued'; label: string }) {
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

function RunRow({ run, onOpen }: { run: SubagentRun; onOpen: (run: SubagentRun) => void }) {
  const { t } = useTranslation();
  const title = runTitle(run, t('rightSidebar.subagents.untitled'));
  const statusLabel = t(`chat.agentTask.status.${run.status}`);
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
        <StatusGlyph status={run.status} label={statusLabel} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-11 leading-4 text-[var(--text-tertiary)]">
          {metadata(run, t).join(' · ')}
        </span>
        {run.summary ? (
          <span className="mt-0.5 block line-clamp-2 text-12 leading-4 text-[var(--text-secondary)]">
            {run.summary}
          </span>
        ) : null}
      </span>
    </button>
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

interface DetailViewProps {
  detail: SubagentRunDetail | null;
  loading: boolean;
  workdir: string;
  allowPrivilegedLinks: boolean;
  stopping: boolean;
  transcript: SubagentTranscriptEntry[];
  transcriptLoading: boolean;
  transcriptCursor: string | null;
  onLoadMoreTranscript: () => void;
  onTechnicalDetailsChange: (open: boolean) => void;
  onBack: () => void;
  onStop: (run: SubagentRunDetail, childId?: string) => void;
  onControl: (
    run: SubagentRunDetail,
    action: 'steer' | 'follow_up' | 'resume',
    message: string,
    childId?: string,
  ) => Promise<boolean>;
}

function LegacyDetailView({
  detail,
  loading,
  workdir,
  allowPrivilegedLinks,
  onBack,
}: Pick<
  DetailViewProps,
  'detail' | 'loading' | 'workdir' | 'allowPrivilegedLinks' | 'onBack'
>) {
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
  const title = runTitle(detail, t('rightSidebar.subagents.untitled'));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-subagent-detail-mode="legacy">
      <HeaderBack onBack={onBack} title={title} status={detail.status} />
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

        {detail.description ? (
          <section className="mt-5">
            <SectionTitle>{t('rightSidebar.subagents.assignment')}</SectionTitle>
            <p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-secondary)]">
              {detail.description}
            </p>
          </section>
        ) : null}

        {detail.capabilities.viewReturnedResult && detail.returnedResult ? (
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
          <section className="mt-5">
            <SectionTitle>{t('rightSidebar.subagents.activity')}</SectionTitle>
            {detail.activity.length > 0 ? (
              <div className="mt-1">
                {detail.activity.map((entry) => (
                  <ActivityRow key={entry.sequence} entry={entry} />
                ))}
              </div>
            ) : (
              <p className="text-12 text-[var(--text-tertiary)]">
                {t('rightSidebar.subagents.noActivity')}
              </p>
            )}
          </section>
        ) : null}

        {!detail.capabilities.viewFullTranscript ? (
          <p className="mt-5 rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.transcriptUnavailable')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptRow({ entry }: { entry: SubagentTranscriptEntry }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg bg-[var(--surface-subtle)] px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-10 text-[var(--text-tertiary)]">
        <span className="min-w-0 break-words font-semibold uppercase tracking-[0.05em]">
          {entry.childTitle ? `${entry.childTitle} · ` : ''}
          {t(`rightSidebar.subagents.transcriptRoles.${entry.role}`)}
          {entry.toolName ? ` · ${entry.toolName}` : ''}
        </span>
        {entry.occurredAt > 0 ? (
          <span className="shrink-0">{new Date(entry.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-12 leading-5 text-[var(--text-secondary)]">
        {entry.content}
      </p>
    </div>
  );
}

function childStatusLabel(child: SubagentChildRun, t: TFunction): string {
  if (child.awaitingApproval) return t('rightSidebar.subagents.awaitingApproval');
  if (child.status === 'queued') return t('rightSidebar.subagents.queued');
  return t(`chat.agentTask.status.${child.status}`);
}

function ChildOverviewButton({
  child,
  onOpen,
}: {
  child: SubagentChildRun;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const statusLabel = childStatusLabel(child, t);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 rounded-[8px] border border-[var(--border-default)] p-3 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
        <StatusGlyph
          status={child.status}
          label={statusLabel}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
          {child.title ?? child.role}
        </span>
        <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
          {[statusLabel, ...childMetadata(child, t)].join(' · ')}
        </span>
        {child.task ? (
          <span className="mt-1 block line-clamp-2 text-12 leading-4 text-[var(--text-secondary)]">
            {child.task}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function PiDurableDetailView({
  detail,
  loading,
  workdir,
  stopping,
  transcript,
  transcriptLoading,
  transcriptCursor,
  onLoadMoreTranscript,
  onTechnicalDetailsChange,
  onBack,
  onStop,
  onControl,
}: DetailViewProps) {
  const { t } = useTranslation();
  const { preference: sendShortcutPreference } = useComposerSendShortcutPreference();
  const [controlDrafts, setControlDrafts] = useState<Record<string, string>>({});
  const [controlAction, setControlAction] = useState<'steer' | 'follow_up' | 'resume'>('steer');
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
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
  const title = runTitle(detail, t('rightSidebar.subagents.untitled'));
  const children = detail.children ?? [];
  const hasMultipleChildren = children.length > 1;
  const selectedChild = selectedChildId
    ? children.find((child) => child.id === selectedChildId)
    : hasMultipleChildren
      ? undefined
      : children[0];
  const visibleTranscript = selectedChild
    ? transcript.filter((entry) => !entry.childId || entry.childId === selectedChild.id)
    : transcript;
  const rawError = selectedChild?.error
    ?? (detail.status === 'failed' && !detail.returnedResult ? detail.summary : undefined);
  const visibleResult = selectedChild
    ? selectedChild.output ?? ''
    : detail.returnedResult ?? (detail.status === 'failed' ? '' : detail.summary ?? '');
  const displayedRunStatus = selectedChild?.status ?? detail.status;
  const selectedChildActive = !selectedChild
    || selectedChild.status === 'running'
    || selectedChild.status === 'queued';
  const selectedChildHasCompletedOutput = Boolean(selectedChild?.output?.trim());
  const controlActions: Array<'steer' | 'follow_up' | 'resume'> =
    detail.status === 'running' && detail.capabilities.steer && selectedChildActive
      ? selectedChildHasCompletedOutput
        ? ['follow_up']
        : ['steer', 'follow_up']
      : detail.status !== 'running' && detail.capabilities.resume
        ? ['resume']
        : [];
  const selectedControlAction = controlActions.includes(controlAction)
    ? controlAction
    : controlActions[0];
  const controlDraftKey = `${selectedChild?.id ?? 'all'}:${selectedControlAction ?? 'none'}`;
  const controlMessage = controlDrafts[controlDraftKey] ?? '';
  const setControlMessage = (message: string): void => {
    setControlDrafts((current) => ({ ...current, [controlDraftKey]: message }));
  };
  const sendShortcutLabel = getComposerSendShortcutLabel(
    sendShortcutPreference,
    window.electronAPI?.platform,
  );
  const submitControl = (): void => {
    const message = controlMessage.trim();
    const action = selectedControlAction;
    if (!message || !action || controlBusy) return;
    setControlBusy(true);
    setControlError(false);
    void onControl(detail, action, message, selectedChild?.id).then((ok) => {
      if (ok) setControlDrafts((current) => ({ ...current, [controlDraftKey]: '' }));
      else setControlError(true);
    }).finally(() => setControlBusy(false));
  };
  const displayedStatus = selectedChild
    ? childStatusLabel(selectedChild, t)
    : t(`chat.agentTask.status.${detail.status}`);
  const displayedMetadata = selectedChild ? childMetadata(selectedChild, t) : metadata(detail, t);
  const selectedOutputTruncated = selectedChild?.outputTruncated ?? detail.returnedResultTruncated;
  const showStop = detail.status === 'running'
    && detail.capabilities.stop
    && selectedChildActive;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HeaderBack
        onBack={onBack}
        title={title}
        status={detail.status}
        action={showStop ? (
          <button
            type="button"
            onClick={() => onStop(detail, selectedChild?.id)}
            disabled={stopping}
            title={t('chat.agentTask.stop')}
            aria-label={t('chat.agentTask.stop')}
            data-subagent-stop="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <Square size={12} aria-hidden="true" />
          </button>
        ) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-5">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          {hasMultipleChildren ? (
            <div
              className="flex max-w-full gap-1 overflow-x-auto"
              role="group"
              aria-label={t('rightSidebar.subagents.children')}
            >
              <button
                type="button"
                aria-pressed={!selectedChild}
                onClick={() => setSelectedChildId(null)}
                className={cn(
                  'h-8 shrink-0 rounded-full px-3 text-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  !selectedChild
                    ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                    : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
                )}
              >
                {t('rightSidebar.subagents.overview')}
              </button>
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  aria-pressed={selectedChild?.id === child.id}
                  onClick={() => setSelectedChildId(child.id)}
                  className={cn(
                    'h-8 shrink-0 rounded-full px-3 text-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    selectedChild?.id === child.id
                      ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                      : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
                  )}
                >
                  {child.title ?? child.role}
                </button>
              ))}
            </div>
          ) : null}
          {hasMultipleChildren && !selectedChild ? (
            <section aria-label={t('rightSidebar.subagents.children')}>
              <SectionTitle>{t('rightSidebar.subagents.children')}</SectionTitle>
              <div className="grid gap-2">
                {children.map((child) => (
                  <ChildOverviewButton
                    key={child.id}
                    child={child}
                    onOpen={() => setSelectedChildId(child.id)}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {(selectedChild?.task ?? detail.description) ? (
            <UserMessage
              workingDir={workdir}
              content={selectedChild?.task ?? detail.description ?? ''}
              createdAt={new Date(detail.startedAt).toISOString()}
            />
          ) : null}

          <div className="flex items-center gap-3 text-12 text-[var(--text-tertiary)]">
            <span className="h-px min-w-4 flex-1 bg-[var(--border-default)]" />
            <span className="min-w-0 max-w-full truncate text-center">
              {displayedStatus}
              {displayedMetadata.length > 0 ? ` · ${displayedMetadata.join(' · ')}` : ''}
            </span>
            <span className="h-px min-w-4 flex-1 bg-[var(--border-default)]" />
          </div>

          {visibleResult ? (
            <AssistantMessage
              workingDir={workdir}
              content={visibleResult}
              createdAt={new Date(detail.updatedAt).toISOString()}
              agentKind="pi"
              showActionBar
            />
          ) : rawError ? null : selectedChild?.awaitingApproval ? (
            <div className="flex items-center gap-2 text-13 text-[var(--text-tertiary)]">
              <Spinner icon={LoaderCircle} spinning size={14} />
              {t('rightSidebar.subagents.awaitingApprovalDetail')}
            </div>
          ) : selectedChild?.status === 'queued' ? (
            <div className="flex items-center gap-2 text-13 text-[var(--text-tertiary)]">
              <Spinner icon={LoaderCircle} spinning size={14} />
              {t('rightSidebar.subagents.queuedDetail')}
            </div>
          ) : detail.status === 'running' ? (
            <div className="flex items-center gap-2 text-13 text-[var(--text-tertiary)]">
              <Spinner icon={LoaderCircle} spinning size={14} />
              {t('rightSidebar.subagents.waitingForReply')}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-13 leading-5 text-[var(--error-fg)]">
              <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              {t(displayedRunStatus === 'failed'
                ? 'rightSidebar.subagents.failedNoReply'
                : displayedRunStatus === 'stopped'
                  ? 'rightSidebar.subagents.stoppedNoReply'
                  : 'rightSidebar.subagents.completedNoReply')}
            </div>
          )}

          {rawError ? <SubagentErrorNotice rawError={rawError} /> : null}

          {selectedOutputTruncated ? (
            <p className="text-11 text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.resultTruncated')}
            </p>
          ) : null}

          {(detail.capabilities.viewActivity || detail.capabilities.viewFullTranscript) ? (
            <div className="border-t border-[var(--border-default)] pt-2">
              <button
                type="button"
                aria-expanded={technicalOpen}
                onClick={() => {
                  const next = !technicalOpen;
                  setTechnicalOpen(next);
                  onTechnicalDetailsChange(next);
                }}
                className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-12 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <ChevronDown
                  size={13}
                  className={cn('transition-transform', technicalOpen && 'rotate-180')}
                  aria-hidden="true"
                />
                {t('rightSidebar.subagents.technicalDetails')}
              </button>
              {technicalOpen ? (
                <div className="mt-3 space-y-5">
                  {detail.capabilities.viewActivity && detail.activity.length > 0 ? (
                    <section>
                      <SectionTitle>{t('rightSidebar.subagents.activity')}</SectionTitle>
                      <div>{detail.activity.map((entry) => <ActivityRow key={entry.sequence} entry={entry} />)}</div>
                    </section>
                  ) : null}
                  {detail.capabilities.viewFullTranscript ? (
                    <section>
                      <SectionTitle>{t('rightSidebar.subagents.transcript')}</SectionTitle>
                      {visibleTranscript.length > 0 ? (
                        <div className="space-y-2">
                          {visibleTranscript.map((entry) => <TranscriptRow key={entry.id} entry={entry} />)}
                        </div>
                      ) : transcriptLoading ? (
                        <div className="flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
                          <Spinner icon={LoaderCircle} spinning size={13} />
                          {t('rightSidebar.subagents.loading')}
                        </div>
                      ) : (
                        <p className="text-12 text-[var(--text-tertiary)]">{t('rightSidebar.subagents.noTranscript')}</p>
                      )}
                      {transcriptCursor ? (
                        <button
                          type="button"
                          disabled={transcriptLoading}
                          onClick={onLoadMoreTranscript}
                          className="mt-3 inline-flex h-8 items-center rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        >
                          {t('rightSidebar.subagents.loadMoreTranscript')}
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {controlActions.length > 0 ? (
        <div className="shrink-0 border-t border-[var(--border-default)] p-3">
          <div className="mx-auto flex max-w-[720px] flex-col gap-2 rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2">
            <p className="px-2 text-10 text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.controlTarget', {
                target: selectedChild?.title ?? selectedChild?.role ?? t('rightSidebar.subagents.allChildren'),
              })}
            </p>
            {selectedChildHasCompletedOutput ? (
              <p className="px-2 text-11 leading-4 text-[var(--text-tertiary)]">
                {t('rightSidebar.subagents.completedOutputFollowUpHint')}
              </p>
            ) : null}
            {controlActions.length > 1 ? (
              <div className="flex w-fit rounded-lg bg-[var(--surface-subtle)] p-0.5" role="group">
                {controlActions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    aria-pressed={selectedControlAction === action}
                    onClick={() => setControlAction(action)}
                    className={cn(
                      'h-7 rounded-md px-2 text-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      selectedControlAction === action
                        ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                    )}
                  >
                    {t(`rightSidebar.subagents.controlActions.${action}`)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <textarea
                value={controlMessage}
                onChange={(event) => setControlMessage(event.target.value)}
                onKeyDown={(event) => {
                  const intent = resolveComposerEnterIntent(
                    event.nativeEvent,
                    sendShortcutPreference,
                    {
                      turnRunning: detail.status === 'running',
                      platform: window.electronAPI?.platform,
                    },
                  );
                  if (intent === 'native' || intent === null) return;
                  event.preventDefault();
                  if (intent !== 'ignore') submitControl();
                }}
                disabled={controlBusy}
                maxLength={32_000}
                rows={2}
                placeholder={t('rightSidebar.subagents.directionPlaceholder')}
                aria-label={t('rightSidebar.subagents.sendDirection')}
                aria-describedby="pi-subagent-send-hint"
                className="min-h-10 min-w-0 flex-1 resize-none rounded-[8px] bg-transparent px-2 py-1.5 text-13 leading-5 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
              />
              <button
                type="button"
                disabled={controlBusy || !controlMessage.trim()}
                onClick={submitControl}
                title={selectedControlAction ? t(`rightSidebar.subagents.controlActions.${selectedControlAction}`) : undefined}
                aria-label={selectedControlAction ? t(`rightSidebar.subagents.controlActions.${selectedControlAction}`) : undefined}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {controlBusy ? (
                  <Spinner icon={LoaderCircle} spinning size={14} />
                ) : (
                  <SendHorizontal size={14} aria-hidden="true" />
                )}
              </button>
            </div>
            <p id="pi-subagent-send-hint" className="px-2 text-10 text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.sendShortcutHint', { shortcut: sendShortcutLabel })}
            </p>
            {controlError ? (
              <p role="alert" className="px-2 text-11 text-[var(--error-fg)]">
                {t('rightSidebar.subagents.controlFailed')}
              </p>
            ) : null}
          </div>
        </div>
      ) : detail.status === 'running' && selectedChild && !selectedChildActive ? (
        <div className="shrink-0 border-t border-[var(--border-default)] px-4 py-3 text-12 text-[var(--text-tertiary)]">
          {t('rightSidebar.subagents.childEndedControlHint')}
        </div>
      ) : null}
    </div>
  );
}

function DetailView(props: DetailViewProps) {
  const isPiDurableDetail = props.detail?.provider === 'pi'
    && props.detail.capabilities.viewFullTranscript;
  return isPiDurableDetail
    ? <PiDurableDetailView key={props.detail?.id} {...props} />
    : <LegacyDetailView {...props} />;
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
  const [transcript, setTranscript] = useState<SubagentTranscriptEntry[]>([]);
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptForRunId, setTranscriptForRunId] = useState<string | null>(null);
  const [transcriptRefreshVersion, setTranscriptRefreshVersion] = useState(0);
  const transcriptTargetRef = useRef<string | null>(null);
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

  const loadTranscript = useCallback(
    async (run: SubagentRunDetail, cursor?: string) => {
      const requestOwner = getDataOwnerGeneration();
      const targetRunId = run.id;
      transcriptTargetRef.current = targetRunId;
      setTranscriptLoading(true);
      try {
        const input = {
          sessionId: ctx.sessionId,
          provider: run.provider,
          runIdOrAlias: run.id,
          ...(cursor ? { cursor } : {}),
        };
        const response = remoteDevice
          ? await window.electronAPI.deviceLink.invoke(
              ctx.deviceLinkDeviceId!,
              'local-db:subagent-runs:transcript',
              [input],
            ) as SubagentTranscriptPageResponse
          : await window.electronAPI.localDb.subagentRuns.transcript(input);
        if (
          !isCurrentSubagentReadOwner(requestOwner)
          || transcriptTargetRef.current !== targetRunId
        ) return;
        setTranscript((current) => cursor ? [...current, ...response.entries] : response.entries);
        setTranscriptCursor(response.nextCursor ?? null);
      } catch {
        if (
          isCurrentSubagentReadOwner(requestOwner)
          && transcriptTargetRef.current === targetRunId
          && !cursor
        ) {
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
    [ctx.deviceLinkDeviceId, ctx.sessionId, remoteDevice],
  );

  useEffect(() => {
    if (!visible || !detail?.capabilities.viewFullTranscript) {
      transcriptTargetRef.current = null;
      setTranscript([]);
      setTranscriptCursor(null);
      setTranscriptForRunId(null);
    }
  }, [detail, visible]);

  useEffect(() => {
    if (
      !visible
      || !detail?.capabilities.viewFullTranscript
      || transcriptForRunId !== detail.id
    ) return;
    setTranscript([]);
    setTranscriptCursor(null);
    void loadTranscript(detail);
  }, [detail, loadTranscript, transcriptForRunId, transcriptRefreshVersion, visible]);

  const grouped = useMemo(
    () => ({
      running: runs.filter((run) => run.status === 'running'),
      finished: runs.filter((run) => run.status !== 'running'),
    }),
    [runs],
  );

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
      action: 'steer' | 'follow_up' | 'resume',
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
        key={`${selectedDetail?.provider ?? selectedProvider ?? 'unknown'}:${selectedDetail?.id ?? selectedRunAlias}`}
        detail={selectedDetail}
        loading={detailLoading || selectedDetail === null}
        workdir={ctx.workdir}
        allowPrivilegedLinks={ctx.deviceLinkDeviceId === null && !ctx.remoteHostId}
        stopping={selectedDetail !== null && stoppingRunId === selectedDetail.id}
        transcript={transcript}
        transcriptLoading={transcriptLoading}
        transcriptCursor={transcriptCursor}
        onLoadMoreTranscript={() => {
          if (selectedDetail && transcriptCursor) void loadTranscript(selectedDetail, transcriptCursor);
        }}
        onTechnicalDetailsChange={(open) => {
          if (!open) {
            transcriptTargetRef.current = null;
            setTranscriptForRunId(null);
            setTranscriptLoading(false);
            return;
          }
          if (selectedDetail?.capabilities.viewFullTranscript) setTranscriptForRunId(selectedDetail.id);
        }}
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
              <RunRow key={run.id} run={run} onOpen={openRun} />
            ))}
          </section>
        ) : null}
        {grouped.finished.length > 0 ? (
          <section className={grouped.running.length > 0 ? 'mt-3' : undefined}>
            <div className="px-2 pb-1 pt-1 text-10 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.finished')}
            </div>
            {grouped.finished.map((run) => (
              <RunRow key={run.id} run={run} onOpen={openRun} />
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
