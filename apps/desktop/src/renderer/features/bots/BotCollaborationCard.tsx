import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  GitPullRequest,
  Megaphone,
  Square,
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
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { usePrActions, usePrRefsForSession, usePrStatuses } from '@/contexts/PrRefsContext';
import { PR_STATUS_COLOR, PR_STATUS_ICON } from '@/features/cc-agent/gitContextPrVisuals';
import { makerChatStore } from '@/lib/makerChatStore';
import { makerApiForSticky } from '@/lib/makerTransport';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { readWorkingPhase, WORKING_PHASE_KEYS } from '../../../shared/workingStatus';
import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import { BOT_INTERJECTION_MAX_CHARS, readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { isActiveDelegationStatus } from './botDelegationLive';
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

/** The one card for a background task, in the reply column; state changes in place. */
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

type CardState = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';

const HARNESS_LABEL: Record<string, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };

function Chip({
  children,
  onClick,
  tone = 'default',
  disabled,
  expanded,
  controls,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      className={cn(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 text-11 transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50',
        tone === 'danger'
          ? 'text-[var(--error-fg)]'
          : 'text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  );
}

function StatusGlyph({ state }: { state: CardState }) {
  if (state === 'starting' || state === 'running') {
    return <Spinner size={12} className="shrink-0 text-[var(--status-bar-accent)]" aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-[7px] shrink-0 rounded-full',
        state === 'waiting' && 'bg-[var(--status-info)]',
        state === 'completed' && 'bg-[var(--status-success)]',
        state === 'failed' && 'bg-[var(--error-fg)]',
        (state === 'cancelled' || state === 'unknown') && 'bg-[var(--text-tertiary)]',
      )}
    />
  );
}

/**
 * Local bot chats only: the owner adds a line to the original task like typing in it.
 * The Bot's chat then keeps the same quiet trace a Bot's own `message_session_task`
 * leaves (first line only). The line is delivered before the trace, so a failed trace
 * never turns a sent note into an error.
 */
async function sendToTask(
  parentSessionId: string | null,
  delegationId: string,
  childSessionId: string,
  text: string,
): Promise<boolean> {
  if (text.length > BOT_INTERJECTION_MAX_CHARS) return false;
  const owner = getDataOwnerGeneration();
  const row = await sessionService.get(childSessionId);
  if (!isDataOwnerGenerationCurrent(owner) || !row?.workingDir) return false;
  const sent = await makerChatStore.sendMessage(
    childSessionId, text, row.model, row.effort, row.permissionMode, row.workingDir,
  );
  if (sent && parentSessionId && isDataOwnerGenerationCurrent(owner)) {
    await window.electronAPI.maker
      .traceBotDelegationNote(parentSessionId, delegationId, text)
      .catch(() => undefined);
  }
  return sent;
}

/**
 * Background task card. A `delegation-request` anchor follows the live task row;
 * a `delegation-result` receipt keeps its frozen status, text, files and error,
 * reading only the title and PR links from the original task. `attached` is the
 * receipt under the bot's closing reply: its result starts open.
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
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const resultId = useId();

  const state: CardState = frozen
    ? frozen.status === 'completed'
      ? 'completed'
      : frozen.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
    : row?.status === 'waiting'
      ? 'waiting'
      : ref.running || row?.status === 'running'
        ? 'running'
        : !row
          ? ref.resolved ? 'unknown' : 'starting'
          : row.status === 'queued'
            ? 'starting'
            : row.status === 'completed'
              ? 'completed'
              : row.status === 'failed' || row.status === 'timed-out'
                ? 'failed'
                : row.status === 'cancelled'
                  ? 'cancelled'
                  : 'unknown';
  const live = state === 'starting' || state === 'running' || state === 'waiting';
  const active = !frozen && Boolean(row && isActiveDelegationStatus(row.status));
  const statusLabel = frozen
    ? t(`bots.collab.status.${frozen.status}`)
    : state === 'unknown'
      ? t('bots.collab.status.unknown')
      : state === 'starting'
        ? t('bots.collab.status.queued')
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
  const canOpen = Boolean(childSessionId) && !ref.originConflict;
  const canAddNote = state === 'running' && Boolean(childSessionId) && !ref.sourceDeviceId && !frozen;
  const resultLabel =
    state === 'completed'
      ? t(resultOpen ? 'bots.collab.collapseResult' : 'bots.collab.expandResult')
      : t(resultOpen ? 'bots.collab.collapseDetails' : 'bots.collab.expandDetails');
  const hasResultBody = Boolean(frozen) || state === 'completed' || state === 'failed' || state === 'cancelled';

  const stop = async () => {
    if (!parentSessionId || pending || !online) return;
    setPending(true);
    setActionError(null);
    try {
      const result = await makerApiForSticky(parentSessionId).cancelBotDelegation(
        parentSessionId,
        card.delegationId,
      );
      if (!result.ok) setActionError(result.message || t('bots.collab.actionFailed'));
    } catch {
      setActionError(t('bots.collab.actionFailed'));
    } finally {
      setPending(false);
    }
  };
  const submitNote = async () => {
    const text = note.trim();
    if (!text || !childSessionId || pending) return;
    setPending(true);
    setActionError(null);
    try {
      if (await sendToTask(parentSessionId, card.delegationId, childSessionId, text)) {
        setNote('');
        setNoteOpen(false);
        toast.success(t('bots.collab.addNoteSent'));
      } else {
        setActionError(t('bots.collab.actionFailed'));
      }
    } catch {
      setActionError(t('bots.collab.actionFailed'));
    } finally {
      setPending(false);
    }
  };
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
  if (state === 'running' || state === 'starting') {
    line2 = (
      <>
        <span className="min-w-0 truncate text-[var(--status-bar-accent)]">
          {state === 'starting' ? t('bots.collab.status.queued') : currentAction}
        </span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
            · {t('bots.collab.elapsed', { duration: elapsed })}
          </span>
        ) : null}
      </>
    );
  } else if (state === 'waiting') {
    const summary = row?.pendingInteraction?.summary?.trim();
    line2 = (
      <span className="min-w-0 line-clamp-2 break-words">
        {summary
          ? t('bots.collab.awaitingConfirm', { summary })
          : t('bots.collab.awaitingConfirmGeneric')}
      </span>
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
        style={{ color: kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)' }}
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
      {noteOpen ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNote();
          }}
        >
          <input
            autoFocus
            value={note}
            maxLength={BOT_INTERJECTION_MAX_CHARS}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setNoteOpen(false);
              }
            }}
            aria-label={t('bots.collab.addNote')}
            placeholder={t('bots.collab.addNotePlaceholder')}
            className="h-8 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </form>
      ) : null}
      {resultOpen && hasResultBody ? (
        <div
          id={resultId}
          className="mt-2 space-y-2 border-t border-[var(--border-default)] pt-2 text-13 text-[var(--text-primary)]"
        >
          <SessionQuickSendProvider value={null}>
            <ChatSessionFileProvider
              value={{ ...fileContext, workingDir, sessionId: childSessionId ?? undefined }}
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
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        {state === 'waiting' && canOpen ? (
          <Chip onClick={ref.open}>
            <Eye size={12} aria-hidden="true" />
            {t('bots.collab.lookAt')}
          </Chip>
        ) : null}
        {(state === 'running' || state === 'starting') && canOpen ? (
          <Chip onClick={ref.open}>
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
            {t('bots.collab.watchWork')}
          </Chip>
        ) : null}
        {canAddNote ? (
          <Chip onClick={() => setNoteOpen((open) => !open)} expanded={noteOpen} disabled={pending}>
            <Megaphone size={12} aria-hidden="true" />
            {t('bots.collab.addNote')}
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
            <span className="truncate" title={`${pr.owner}/${pr.repo} #${pr.prNumber}`}>
              PR #{pr.prNumber}
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
          {active ? (
            <Chip
              tone="danger"
              disabled={pending || !parentSessionId || !online}
              onClick={() => void stop()}
            >
              <Square size={12} aria-hidden="true" />
              {t('bots.collab.stop')}
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
