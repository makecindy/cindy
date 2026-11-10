import { prNumberLabel, prKindLabel } from '@cindy/maker-shared';
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  GitPullRequest,
  Megaphone,
  SquareArrowOutUpRight,
  TriangleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MAX_STATUS_QUERIES, prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { useElementVisible } from '@/cindy-brain/ghostUnreadStore';
import {
  ChatSessionFileProvider,
  useChatSessionFile,
} from '@/components/chat/ChatSessionFileContext';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { SessionQuickSendProvider } from '@/components/chat/SessionQuickSendContext';
import { usePrActions, usePrRefsForSession, usePrStatuses } from '@/contexts/PrRefsContext';
import { prStatusColor, PR_STATUS_ICON } from '@/features/cc-agent/gitContextPrVisuals';
import { cn } from '@/lib/utils';
import { readWorkingPhase, WORKING_PHASE_KEYS } from '../../../shared/workingStatus';
import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { useBotTaskSession } from './BotSessionTaskLink';
import { useRemoteBots } from './useRemoteBots';

/**
 * 「用时」是说给人听的，不是给日志看的：中文界面里 `8s` 和「用时」并排是两套语言。
 * 单位走 i18n，按秒 / 分 / 时+分 / 天+时+分显示。
 */
export function formatBotCollaborationDuration(
  t: (key: string, options?: Record<string, unknown>) => string,
  startedAt: number,
  endedAt: number,
): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return t('bots.collab.duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.collab.duration.minutes', { n: minutes });
  if (seconds >= 86_400) {
    return t('bots.collab.duration.daysHoursMinutes', {
      d: Math.floor(seconds / 86_400),
      h: Math.floor((seconds % 86_400) / 3_600),
      m: minutes % 60,
    });
  }
  return t('bots.collab.duration.hoursMinutes', {
    h: Math.floor(minutes / 60),
    m: minutes % 60,
  });
}

/** 只认结构化标记；形状不对就当没有卡，交回普通文本渲染。 */
export function readBotCollaborationCardData(
  data: Record<string, unknown> | undefined,
): { meta: BotCollaborationMeta; text: string } | null {
  const meta = readBotCollaborationMeta(data);
  if (!meta) return null;
  return { meta, text: typeof data?.text === 'string' ? data.text : '' };
}

interface Props {
  data?: Record<string, unknown>;
  /** 卡片所在的父任务。 */
  sessionId?: string;
}

/** The one card for a V1 background task, in the reply column. Read-only history. */
export function BotSessionTaskCard({ data, sessionId }: Props) {
  const parsed = readBotCollaborationCardData(data);
  if (!parsed || parsed.meta.role !== 'delegation-request') return null;
  return <BotTaskCard card={parsed.meta} sessionId={sessionId} />;
}

/** A quiet persisted trace for a message added to an already-running task. */
export function BotSessionTaskMessageTrace({ data }: Pick<Props, 'data'>) {
  const parsed = readBotCollaborationCardData(data);
  const { t } = useTranslation();
  if (!parsed || parsed.meta.role !== 'interjection') return null;
  const preview = parsed.meta.interjectionPreview;
  return (
    <div className="my-1.5 flex items-start gap-2 text-12 leading-relaxed text-[var(--text-tertiary)]">
      <Megaphone size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {/* Old traces carry no text; they keep the generic copy. */}
        {preview ? t('bots.collab.messageSentWithText', { text: preview }) : t('bots.collab.messageSent')}
      </span>
    </div>
  );
}

type CardState = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

const HARNESS_LABEL: Record<string, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };

function Chip({
  children,
  onClick,
  expanded,
  controls,
}: {
  children: ReactNode;
  onClick: () => void;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      className={cn(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 text-11 transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  );
}

function StatusGlyph({ state }: { state: CardState }) {
  if (state === 'running') {
    return <span className="size-2 shrink-0 rounded-full bg-[var(--warning-accent)] session-status-breathing" aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-[7px] shrink-0 rounded-full',
        state === 'completed' && 'bg-[var(--card-status-done)]',
        state === 'failed' && 'bg-[var(--card-status-error)]',
        (state === 'cancelled' || state === 'unknown') && 'bg-[var(--text-tertiary)]',
      )}
    />
  );
}

/**
 * V1 background task card, read-only. A `delegation-request` anchor shows the stored task row
 * (nothing updates it any more: an unfinished row shows the original task's real running state,
 * otherwise "unknown"); a `delegation-result` receipt keeps its frozen status, text, files and
 * error, reading only the title and PR links from the original task. `attached` is the receipt
 * under the bot's closing reply: its result starts open.
 */
export function BotTaskCard({
  card,
  sessionId,
  attached = false,
  inset = false,
}: {
  card: BotCollaborationMeta;
  sessionId?: string;
  attached?: boolean;
  /** Inside a message bubble (group chat): a flat inset instead of a bordered card. */
  inset?: boolean;
}) {
  const { t } = useTranslation();
  const fileContext = useChatSessionFile();
  const ref = useBotTaskSession(card, sessionId);
  const { row, session, activity } = ref;
  const frozen = card.role === 'delegation-result' ? card.result : undefined;
  const parentSessionId = sessionId ?? card.parentSessionId ?? null;
  const childSessionId = ref.targetId;
  const remoteBots = useRemoteBots();
  const online =
    !ref.sourceDeviceId || remoteBots.some((bot) => bot.deviceId === ref.sourceDeviceId && bot.online);
  const [resultOpen, setResultOpen] = useState(attached);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const resultId = useId();

  const state: CardState = frozen
    ? frozen.status === 'completed'
      ? 'completed'
      : frozen.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
    : row?.status === 'completed'
      ? 'completed'
      : row?.status === 'failed' || row?.status === 'timed-out'
        ? 'failed'
        : row?.status === 'cancelled'
          ? 'cancelled'
          : ref.running
            ? 'running'
            : 'unknown';
  const live = state === 'running';
  const statusLabel = frozen
    ? t(`bots.collab.status.${frozen.status}`)
    : t(`bots.collab.status.${state === 'failed' && row ? row.status : state}`);

  // 只在还在干活时起秒级 tick，收拢后不再空转。
  useEffect(() => {
    if (!live || frozen) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live, frozen]);

  const { ref: observeCard, visible } = useElementVisible();
  const { registerPrConsumer, invalidateRemotePrRefs } = usePrActions();
  const pullRequests = usePrRefsForSession(childSessionId ?? '').slice(0, MAX_STATUS_QUERIES);
  const { statuses, successfulStatuses, refreshError } = usePrStatuses(childSessionId ?? '');
  useEffect(() => {
    if (!visible || !childSessionId) return;
    return registerPrConsumer(childSessionId, ref.sourceDeviceId);
  }, [visible, childSessionId, ref.sourceDeviceId, registerPrConsumer]);
  useEffect(() => {
    if (visible && childSessionId && ref.sourceDeviceId && row?.updatedAt !== undefined) {
      invalidateRemotePrRefs(childSessionId);
    }
  }, [visible, childSessionId, ref.sourceDeviceId, row?.updatedAt, invalidateRemotePrRefs]);

  const title =
    (frozen?.title?.trim() ||
      (frozen ? row?.title?.trim() || session?.title : session?.title || row?.title) ||
      card.objective.trim().split('\n')[0] ||
      t('bots.collab.backgroundTask'));
  const harness = session ? HARNESS_LABEL[session.agentKind] : undefined;
  const startedAt = row ? (row.acceptedAt ?? row.createdAt) : null;
  const elapsed =
    !frozen && live && startedAt !== null ? formatBotCollaborationDuration(t, startedAt, now) : null;
  const took =
    !frozen && !live && row && row.completedAt !== null
      ? formatBotCollaborationDuration(t, row.createdAt, row.completedAt)
      : null;
  const phase = readWorkingPhase(activity?.workingPhase);
  const currentAction =
    activity?.compactDetail?.trim() || t(WORKING_PHASE_KEYS[phase ?? 'processing']);
  const resultText = frozen ? frozen.text : (row?.resultSummary ?? '');
  const errorText = frozen ? frozen.error : row?.lastError?.replace(/^[A-Z_]+:\s*/, '') || undefined;
  const files: string[] = frozen
    ? frozen.artifacts.map((file) => file.absolutePath)
    : (row?.artifacts ?? []).flatMap((file) => (file.absolutePath ? [file.absolutePath] : []));
  // Older remote hosts may omit the list; never let a missing field break the card.
  const fileCount = frozen ? frozen.artifacts.length : (row?.artifacts?.length ?? 0);
  // Relative links in the result belong to the background task's own directory, which may
  // differ from the Bot's main task: the frozen receipt records it, the live card reads the
  // child session's. The surrounding chat's directory is only the last resort.
  const workingDir = frozen?.workingDir ?? session?.workingDir ?? fileContext.workingDir;
  // The result is the child's: a confirmed-local chat does not make a child that runs on another
  // device (or over SSH, or with a conflicting origin) local, and its directory must not be
  // searched on this machine. Until the child's row has loaded its ownership is unknown.
  const childLocalConfirmed =
    fileContext.localConfirmed === true &&
    session !== null &&
    !ref.sourceDeviceId &&
    !ref.originConflict &&
    !session?.deviceLinkDeviceId &&
    !session?.remoteHostId;
  const canOpen = Boolean(childSessionId) && !ref.originConflict;
  const resultLabel =
    state === 'completed'
      ? t(resultOpen ? 'bots.collab.collapseResult' : 'bots.collab.expandResult')
      : t(resultOpen ? 'bots.collab.collapseDetails' : 'bots.collab.expandDetails');
  const hasResultBody = Boolean(frozen) || state === 'completed' || state === 'failed' || state === 'cancelled';

  const openPr = (url: string) => {
    setActionError(null);
    void window.electronAPI
      .openExternal(url)
      .then((result) => {
        if (!result.success) setActionError(t('bots.collab.actionFailed'));
      })
      .catch(() => setActionError(t('bots.collab.actionFailed')));
  };

  const meta = [
    t('bots.collab.backgroundTask'),
    harness,
    took ? t('bots.collab.tookTime', { duration: took }) : null,
  ].filter(Boolean).join(' · ');

  let line2: ReactNode = null;
  if (state === 'running') {
    line2 = (
      <>
        <span className="min-w-0 truncate text-[var(--status-bar-accent)]">{currentAction}</span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
            · {t('bots.collab.elapsed', { duration: elapsed })}
          </span>
        ) : null}
      </>
    );
  } else if (state === 'completed' && resultText.trim() && !resultOpen) {
    line2 = (
      <span className="min-w-0 line-clamp-2 whitespace-pre-wrap break-words text-13 leading-[1.6] text-[var(--text-primary)]">
        {resultText.trim()}
      </span>
    );
  } else if (state === 'failed' && errorText && !resultOpen) {
    line2 = <span className="min-w-0 truncate text-[var(--error-fg)]">{errorText}</span>;
  }

  const prIcon = (pr: (typeof pullRequests)[number]) => {
    const result = statuses.get(prStatusKey(pr));
    const confirmed = result?.ok ? result : successfulStatuses.get(prStatusKey(pr));
    const kind = confirmed?.ok ? confirmed.status : undefined;
    const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
    return (
      <Icon
        size={12}
        aria-hidden="true"
        style={{ color: prStatusColor(kind ?? null, confirmed?.ok ? confirmed.conflicts : null) }}
      />
    );
  };
  const stale =
    (ref.stale ||
      refreshError ||
      !online ||
      pullRequests.some((pr) => statuses.get(prStatusKey(pr))?.ok === false)) &&
    Boolean(row);

  return (
    <div
      ref={observeCard}
      data-bot-task-card={state}
      className={inset
        ? 'w-full min-w-0 rounded-lg bg-[var(--surface)] px-3 py-2.5'
        : 'my-2 w-full min-w-0 max-w-[560px] rounded-xl border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)] px-3 py-2.5'}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph state={state} />
        <span className="sr-only">{statusLabel}</span>
        <button
          data-chat-copy-content
          type="button"
          disabled={!canOpen}
          onClick={ref.open}
          title={statusLabel}
          className="min-w-0 flex-1 truncate text-left text-13 font-medium text-[var(--text-primary)] underline-offset-[3px] enabled:hover:underline disabled:cursor-default"
        >
          {title}
        </button>
        {/* The title keeps its room in a narrow column (Thread open); the meta line gives way first. */}
        <span className="min-w-0 max-w-[55%] shrink truncate text-11 text-[var(--text-tertiary)]">{meta}</span>
      </div>
      {line2 ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          {line2}
        </div>
      ) : null}
      {stale ? (
        <p className="mt-1 flex items-center gap-1.5 text-12 text-[var(--text-tertiary)]">
          <TriangleAlert size={12} aria-hidden="true" />
          {t('bots.collab.stale')}
        </p>
      ) : null}
      {resultOpen && hasResultBody ? (
        <div
          id={resultId}
          className="mt-2 space-y-2 border-t border-[var(--border-default)] pt-2 text-13 text-[var(--text-primary)]"
        >
          <SessionQuickSendProvider value={null}>
            <ChatSessionFileProvider
              value={{
                ...fileContext,
                workingDir,
                sessionId: childSessionId ?? undefined,
                localConfirmed: childLocalConfirmed,
              }}
            >
              {resultText ? (
                <MarkdownRenderer
                  workingDir={workingDir}
                  currentSessionId={childSessionId ?? undefined}
                  renderRichAnswers
                  streamFadeKey={`bot-result:${childSessionId ?? parentSessionId}:${card.delegationId}`}
                  content={resultText}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                  {t('bots.collab.noWrittenResult')}
                </p>
              )}
              {files.map((path) => (
                <MarkdownRenderer
                  key={path}
                  workingDir={workingDir}
                  currentSessionId={childSessionId ?? undefined}
                  content={`[${
                    path
                      .split(/[\\/]/)
                      .pop()
                      ?.replace(/[[\]\\]/g, '\\$&') ?? t('bots.collab.viewResult')
                  }](<${encodeURI(path).replace(/[<>?#]/g, encodeURIComponent)}>)`}
                />
              ))}
            </ChatSessionFileProvider>
          </SessionQuickSendProvider>
          {errorText ? (
            <details>
              <summary className="flex min-h-8 cursor-pointer items-center rounded-lg text-12 text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2">
                {t('appError.details')}
              </summary>
              <p className="whitespace-pre-wrap break-words text-12 text-[var(--text-secondary)]">
                {errorText}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
      <div data-chat-copy-exclude className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        {state === 'running' && canOpen ? (
          <Chip onClick={ref.open}>
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
            {t('bots.collab.watchWork')}
          </Chip>
        ) : null}
        {!live && fileCount > 0 ? (
          <Chip onClick={() => setResultOpen(true)} controls={resultId}>
            <FileText size={12} aria-hidden="true" />
            {t('bots.collab.artifactCount', { count: fileCount })}
          </Chip>
        ) : null}
        {pullRequests.map((pr) => (
          <Chip key={pr.url} onClick={() => openPr(sessionPrUrl(pr))}>
            {prIcon(pr)}
            <span className="truncate" title={`${pr.owner}/${pr.repo} ${prNumberLabel(pr)}`}>
              {prKindLabel(pr)} {prNumberLabel(pr)}
            </span>
          </Chip>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!live && hasResultBody ? (
            <Chip
              onClick={() => setResultOpen((open) => !open)}
              expanded={resultOpen}
              controls={resultId}
            >
              {resultOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              {resultLabel}
            </Chip>
          ) : null}
          {!live && canOpen ? (
            <Chip onClick={ref.open}>
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
              {t('bots.collab.watchWork')}
            </Chip>
          ) : null}
        </span>
      </div>
      {actionError ? (
        <p role="alert" className="mt-1.5 text-11 text-[var(--error-fg)]">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
