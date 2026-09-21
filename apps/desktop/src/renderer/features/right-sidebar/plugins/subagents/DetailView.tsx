/**
 * DetailView — a single Subagent run, read as a conversation.
 *
 * Routing: PI durable runs (the only product surface) get the session-style
 * conversation view; anything else falls back to `LegacyDetailView`, the
 * read-only summary kept for Claude Code / Codex records collected by the
 * internal compatibility layer.
 *
 * The PI view's contract:
 *  - The transcript *is* the conversation. Parent lines are user bubbles,
 *    subagent lines are assistant prose, tool frames are folded cards, and
 *    runtime noise (`role: 'system'`) is routed to technical details.
 *  - Nothing is rendered twice: `returnedResult` is the transcript's last
 *    assistant message, so it only renders when the transcript did not supply
 *    one. The test is "no assistant item", not "no items at all" — a run that
 *    hit the 50MB transcript cap, or whose reply sits outside the eagerly paged
 *    window, still shows task and tool items, and gating on those swallowed a
 *    result the durable record had (older records, truncated storage, remote
 *    devices that do not expose the transcript).
 *  - Run meta (harness · model · duration · tokens) is one quiet line at the
 *    top instead of a divider stripe cutting through the conversation.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, LoaderCircle, SendHorizontal, Square } from 'lucide-react';
import type {
  SubagentChildRun,
  SubagentRunDetail,
  SubagentTranscriptEntry,
} from '@cindy/maker-shared/subagent-workspace';

import { AssistantMessage } from '@/components/chat/AssistantMessage';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { UserMessage } from '@/components/chat/UserMessage';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  getComposerModifierShortcutLabel,
  getComposerSendShortcutLabel,
  resolveComposerEnterIntent,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { cn } from '@/lib/utils';
import { ConversationStream } from './ConversationStream';
import {
  ActivityRow,
  CenteredState,
  HeaderBack,
  SectionTitle,
  StatusGlyph,
  SubagentErrorNotice,
  SystemLogRow,
} from './SubagentChrome';
import {
  buildSubagentConversation,
  lastAssistantItemId,
} from './subagentConversation';
import {
  childMetadata,
  childStatusLabel,
  metadata,
  providerLabel,
  runTitle,
} from './subagentFormat';

export type SubagentControlIntent = 'steer' | 'follow_up' | 'resume';

export interface SubagentDetailViewProps {
  detail: SubagentRunDetail | null;
  loading: boolean;
  workdir: string;
  allowPrivilegedLinks: boolean;
  stopping: boolean;
  transcript: readonly SubagentTranscriptEntry[];
  transcriptLoading: boolean;
  /** Non-null only when the eager paging loop stopped at its page bound. */
  transcriptCursor: string | null;
  onLoadMoreTranscript: () => void;
  onBack: () => void;
  onStop: (run: SubagentRunDetail, childId?: string) => void;
  onControl: (
    run: SubagentRunDetail,
    action: SubagentControlIntent,
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
  SubagentDetailViewProps,
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
            <p className="select-text whitespace-pre-wrap text-12 leading-5 text-[var(--text-secondary)]">
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
            <p className="select-text whitespace-pre-wrap text-12 leading-5 text-[var(--text-secondary)]">
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
          <p className="mt-5 rounded-xl bg-[var(--msg-code-block-bg)] px-3 py-2 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.transcriptUnavailable')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChildOverviewCard({
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
      className="flex w-full items-start gap-2.5 rounded-xl border border-[var(--border-default)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
        <StatusGlyph status={child.status} label={statusLabel} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
          {child.title ?? child.role}
        </span>
        {child.task ? (
          <span className="mt-0.5 block line-clamp-2 text-12 leading-4 text-[var(--text-secondary)]">
            {child.task}
          </span>
        ) : null}
        <span className="mt-1 block truncate text-11 leading-4 text-[var(--text-tertiary)]">
          {childMetadata(child, t).join(' · ')}
        </span>
      </span>
    </button>
  );
}

function ChildChip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'h-7 shrink-0 select-none rounded-full px-3 text-11 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        selected
          ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
          : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
      )}
    >
      {label}
    </button>
  );
}

function PiDurableDetailView({
  detail,
  loading,
  workdir,
  allowPrivilegedLinks,
  stopping,
  transcript,
  transcriptLoading,
  transcriptCursor,
  onLoadMoreTranscript,
  onBack,
  onStop,
  onControl,
}: SubagentDetailViewProps) {
  const { t } = useTranslation();
  const { preference: sendShortcutPreference } = useComposerSendShortcutPreference();
  const [controlDrafts, setControlDrafts] = useState<Record<string, string>>({});
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const children = detail?.children ?? [];
  const hasMultipleChildren = children.length > 1;
  // The selection survives a resume, which renames the child underneath it: the
  // id held here is the generation the user clicked, and the detail now carries
  // the next one. Resolving on the current id alone returned undefined, which
  // this component reads as "no child selected" — so a parallel run went back to
  // showing every sibling's transcript under a chip the user had picked to
  // narrow it. Match the whole identity, not the latest label.
  const resolvedChild = selectedChildId
    ? children.find((child) => (
      child.id === selectedChildId || child.identityAliases?.includes(selectedChildId) === true
    ))
    : undefined;
  // A selection that resolves to nothing at all (an id from a run that is no
  // longer listed) falls back to exactly what no selection does, rather than to
  // "unfiltered": with one child that is still that child's own conversation,
  // and with several it is the overview.
  const selectedChild = resolvedChild ?? (hasMultipleChildren ? undefined : children[0]);
  // Every id this child has ever had. A resumed generation labels the same
  // conversation with a new `childId`, so matching on the current one alone
  // filtered the child's own earlier generations back out of the transcript the
  // Host had just gone to the trouble of reading across all of them — and a
  // resumed run auto-selects that child, so it was the default view.
  const selectedChildIds = useMemo(
    () => (selectedChild
      ? new Set([selectedChild.id, ...(selectedChild.identityAliases ?? [])])
      : null),
    [selectedChild],
  );
  const visibleTranscript = useMemo(
    () => (selectedChildIds
      ? transcript.filter((entry) => !entry.childId || selectedChildIds.has(entry.childId))
      : transcript),
    [selectedChildIds, transcript],
  );
  const conversation = useMemo(
    () => buildSubagentConversation(visibleTranscript),
    [visibleTranscript],
  );

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
  // The composer works like the session's: one box, one send, and the same
  // keystrokes. While running, plain send queues a follow-up and the modifier
  // send interjects (steer) — exactly the main composer's Enter / ⌘+Enter
  // split. A settled reply may not be steered over, and a finished run reads
  // any send as continuing it.
  const composerActionForIntent = (
    intent: 'queue' | 'steer',
  ): SubagentControlIntent | undefined => {
    if (detail.status !== 'running') {
      return detail.capabilities.resume ? 'resume' : undefined;
    }
    if (!detail.capabilities.steer || !selectedChildActive) return undefined;
    if (intent === 'steer' && !selectedChildHasCompletedOutput) return 'steer';
    return 'follow_up';
  };
  const defaultComposerAction = composerActionForIntent('queue');
  const steerAvailable = composerActionForIntent('steer') === 'steer';
  const controlDraftKey = selectedChild?.id ?? 'all';
  const controlMessage = controlDrafts[controlDraftKey] ?? '';
  const setControlMessage = (message: string): void => {
    setControlDrafts((current) => ({ ...current, [controlDraftKey]: message }));
  };
  const sendShortcutLabel = getComposerSendShortcutLabel(
    sendShortcutPreference,
    window.electronAPI?.platform,
  );
  const submitControl = (action: SubagentControlIntent | undefined): void => {
    const message = controlMessage.trim();
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

  const hasConversation = conversation.items.length > 0;
  // Whether the transcript actually carries the agent's reply — not merely
  // *some* item. A long run can hit the 50MB transcript cap, or keep its reply
  // outside the eagerly paged window, leaving only task and tool items behind.
  // Gating the durable-result fallback on "any item" then swallowed a finished
  // result that the durable record still had.
  //
  // Scoped to the *current* generation. The transcript now carries every
  // generation of this child permanently, so a reply the previous one gave
  // would otherwise go on standing in for a newest generation that has none —
  // truncated at the 50MB cap, unreadable, or simply outside the paged window.
  // That is a steady state, not a moment: the user would be left reading the
  // old answer with the new `returnedResult` nowhere on screen.
  //
  // Judged on the transcript entries rather than `conversation.items`, which
  // drop `childId` in the projection. `entry.role === 'subagent'` is exactly
  // the predicate that produces a `kind: 'subagent'` item, so the two cannot
  // disagree. An entry with no `childId` at all — a single-generation record,
  // or an older wire format — counts as current, which is what it always was
  // before aliases existed.
  const currentGenerationChildIds = useMemo(
    () => new Set(selectedChild ? [selectedChild.id] : children.map((child) => child.id)),
    [children, selectedChild],
  );
  const hasAssistantItem = useMemo(
    () => visibleTranscript.some((entry) => (
      entry.role === 'subagent'
      && (!entry.childId || currentGenerationChildIds.has(entry.childId))
    )),
    [currentGenerationChildIds, visibleTranscript],
  );
  // Old or truncated records can start mid-run. The assignment is still the
  // first thing the user needs, so it is prepended when the transcript itself
  // carries no parent line.
  const assignment = selectedChild?.task ?? detail.description ?? '';
  const showAssignmentFallback = Boolean(assignment)
    && !conversation.items.some((item) => item.kind === 'parent');
  // Same criterion as the fallback below, so "a reply is on screen" and "we
  // rendered one" cannot disagree: previously this counted a `visibleResult`
  // that the suppressed fallback never drew, so neither the result nor the
  // missing-reply notice appeared.
  /**
   * Is what we are looking at the *end* of this generation's transcript?
   *
   * Two ways it is not. The runner stops appending the moment the record hits
   * its byte cap and writes a `transcript-truncated` marker — so truncation
   * always loses the *tail*, which is exactly where the newest reply is. And the
   * renderer pages head-first with a page bound, so a long transcript can stop
   * short with `transcriptCursor` still set.
   */
  const currentGenerationTruncated = useMemo(
    () => conversation.system.some((entry) => (
      entry.systemEvent?.kind === 'transcript-truncated'
      && (!entry.childId || currentGenerationChildIds.has(entry.childId))
    )),
    [conversation.system, currentGenerationChildIds],
  );
  const transcriptTailComplete = transcriptCursor === null && !currentGenerationTruncated;
  // An assistant item is only proof that *this* generation replied — not that we
  // are looking at its latest reply. A follow-up produces another `message_end`,
  // and the runner overwrites `task.output` each time, so the durable result is
  // always the newest one while the transcript may still be showing an earlier
  // one. With the tail missing, "some assistant line exists" and "the newest
  // reply is on screen" come apart, and suppressing on the first was how the
  // user ended up reading a stale answer with the current one nowhere.
  //
  // When the tail is complete this is exactly the previous condition. When it is
  // not, the result is shown even at the cost of repeating a reply that happens
  // to already be visible: seeing the newest answer twice is a far smaller
  // failure than not seeing it at all.
  const showDurableResultFallback =
    (!hasAssistantItem || !transcriptTailComplete) && Boolean(visibleResult);
  const hasAssistantReply = hasAssistantItem || showDurableResultFallback;
  // A parallel run stays `running` until its last child settles, so the run
  // status alone would keep a waiting spinner under a child that already
  // finished — contradicting that child's own terminal label and its disabled
  // composer on the same screen. When a child is selected the wait belongs to
  // that child; `selectedChildActive` is already true with no child selected,
  // so the overview and single-child aggregate keep their existing behaviour.
  const activeNoticeKey = selectedChild?.awaitingApproval
    ? 'awaitingApprovalDetail'
    : selectedChild?.status === 'queued'
      ? 'queuedDetail'
      : detail.status === 'running' && selectedChildActive
        ? 'waitingForReply'
        : null;
  const actionBarItemId = detail.status === 'running'
    ? null
    : lastAssistantItemId(conversation.items);
  const showTechnical = detail.capabilities.viewActivity || detail.capabilities.viewFullTranscript;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-subagent-detail-mode="pi-durable">
      <HeaderBack
        onBack={onBack}
        title={title}
        status={detail.status}
        action={showStop ? (
          <Tip text={t('chat.agentTask.stop')} side="bottom">
            <button
              type="button"
              onClick={() => onStop(detail, selectedChild?.id)}
              disabled={stopping}
              aria-label={t('chat.agentTask.stop')}
              data-subagent-stop="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <Square size={12} aria-hidden="true" />
            </button>
          </Tip>
        ) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
          <p className="select-none truncate text-11 leading-4 text-[var(--text-tertiary)]">
            {[displayedStatus, ...displayedMetadata].join(' · ')}
          </p>

          {hasMultipleChildren ? (
            <div
              className="flex max-w-full gap-1 overflow-x-auto"
              role="group"
              aria-label={t('rightSidebar.subagents.children')}
            >
              <ChildChip
                label={t('rightSidebar.subagents.overview')}
                selected={!selectedChild}
                onSelect={() => setSelectedChildId(null)}
              />
              {children.map((child) => (
                <ChildChip
                  key={child.id}
                  label={child.title ?? child.role}
                  selected={selectedChild?.id === child.id}
                  onSelect={() => setSelectedChildId(child.id)}
                />
              ))}
            </div>
          ) : null}

          {hasMultipleChildren && !selectedChild ? (
            <section aria-label={t('rightSidebar.subagents.children')}>
              <SectionTitle>{t('rightSidebar.subagents.children')}</SectionTitle>
              <div className="grid gap-2">
                {children.map((child) => (
                  <ChildOverviewCard
                    key={child.id}
                    child={child}
                    onOpen={() => setSelectedChildId(child.id)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {showAssignmentFallback ? (
            <UserMessage
              workingDir={workdir}
              allowPrivilegedLinks={allowPrivilegedLinks}
              content={assignment}
              createdAt={new Date(detail.startedAt).toISOString()}
            />
          ) : null}

          {hasConversation ? (
            <ConversationStream
              items={conversation.items}
              workdir={workdir}
              allowPrivilegedLinks={allowPrivilegedLinks}
              actionBarItemId={actionBarItemId}
            />
          ) : null}

          {/* The durable result, only when the transcript did not already carry
              the reply — a complete transcript ending in that result must not
              render it a second time. */}
          {showDurableResultFallback ? (
            <AssistantMessage
              workingDir={workdir}
              allowPrivilegedLinks={allowPrivilegedLinks}
              content={visibleResult}
              createdAt={new Date(detail.updatedAt).toISOString()}
              agentKind="pi"
              showActionBar
            />
          ) : null}

          {activeNoticeKey ? (
            <div className="flex items-center gap-2 text-13 text-[var(--text-tertiary)]">
              <Spinner icon={LoaderCircle} spinning size={14} />
              {t(`rightSidebar.subagents.${activeNoticeKey}`)}
            </div>
          ) : !hasAssistantReply && !rawError ? (
            <div className="flex items-start gap-2 text-13 leading-5 text-[var(--error-fg)]">
              <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              {t(displayedRunStatus === 'failed'
                ? 'rightSidebar.subagents.failedNoReply'
                : displayedRunStatus === 'stopped'
                  ? 'rightSidebar.subagents.stoppedNoReply'
                  : 'rightSidebar.subagents.completedNoReply')}
            </div>
          ) : null}

          {rawError ? <SubagentErrorNotice rawError={rawError} /> : null}

          {selectedOutputTruncated ? (
            <p className="text-11 text-[var(--text-tertiary)]">
              {t('rightSidebar.subagents.resultTruncated')}
            </p>
          ) : null}

          {showTechnical ? (
            <div className="border-t border-[var(--border-default)] pt-2">
              <button
                type="button"
                aria-expanded={technicalOpen}
                onClick={() => setTechnicalOpen((current) => !current)}
                className="inline-flex h-8 select-none items-center gap-1 rounded-full px-2 text-12 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
                      <div>
                        {detail.activity.map((entry) => (
                          <ActivityRow key={entry.sequence} entry={entry} />
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {detail.capabilities.viewFullTranscript ? (
                    <section>
                      <SectionTitle>{t('rightSidebar.subagents.systemLog')}</SectionTitle>
                      {conversation.system.length > 0 ? (
                        <div className="space-y-1.5">
                          {conversation.system.map((entry) => (
                            <SystemLogRow key={entry.id} entry={entry} />
                          ))}
                        </div>
                      ) : transcriptLoading ? (
                        <div className="flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
                          <Spinner icon={LoaderCircle} spinning size={13} />
                          {t('rightSidebar.subagents.loading')}
                        </div>
                      ) : (
                        <p className="text-12 text-[var(--text-tertiary)]">
                          {t('rightSidebar.subagents.noSystemLog')}
                        </p>
                      )}
                      {transcriptCursor ? (
                        <button
                          type="button"
                          disabled={transcriptLoading}
                          onClick={onLoadMoreTranscript}
                          className="mt-3 inline-flex h-8 items-center rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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

      {defaultComposerAction ? (
        <div className="shrink-0 border-t border-[var(--border-default)] p-3">
          <div className="mx-auto flex max-w-[720px] flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2">
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
                  if (intent === 'ignore') return;
                  submitControl(composerActionForIntent(intent));
                }}
                disabled={controlBusy}
                maxLength={32_000}
                rows={2}
                placeholder={steerAvailable && sendShortcutPreference === 'enter'
                  ? t('rightSidebar.subagents.composerPlaceholders.runningWithSteer', {
                      steerShortcut: getComposerModifierShortcutLabel(window.electronAPI?.platform),
                    })
                  : t(`rightSidebar.subagents.composerPlaceholders.${defaultComposerAction}`)}
                aria-label={t('rightSidebar.subagents.sendDirection')}
                title={t('rightSidebar.subagents.sendShortcutHint', { shortcut: sendShortcutLabel })}
                className="min-h-10 min-w-0 flex-1 resize-none rounded-lg bg-transparent px-2 py-1.5 text-13 leading-5 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
              />
              <Tip text={t(`rightSidebar.subagents.controlActions.${defaultComposerAction}`)} side="top">
                <button
                  type="button"
                  disabled={controlBusy || !controlMessage.trim()}
                  onClick={() => submitControl(defaultComposerAction)}
                  aria-label={t(`rightSidebar.subagents.controlActions.${defaultComposerAction}`)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  {controlBusy ? (
                    <Spinner icon={LoaderCircle} spinning size={14} />
                  ) : (
                    <SendHorizontal size={14} aria-hidden="true" />
                  )}
                </button>
              </Tip>
            </div>
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

export function DetailView(props: SubagentDetailViewProps) {
  const isPiDurableDetail = props.detail?.provider === 'pi'
    && props.detail.capabilities.viewFullTranscript;
  return isPiDurableDetail
    ? <PiDurableDetailView key={props.detail?.id} {...props} />
    : <LegacyDetailView {...props} />;
}
