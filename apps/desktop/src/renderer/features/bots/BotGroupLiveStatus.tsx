import { useNavigate } from 'react-router-dom';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
/** Group progress stays above the composer. Each execution opens its original standard
 * task, locally or on its authenticated home computer; confirmations stay inline. */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { cn } from '@/lib/utils';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { readWorkingPhase } from '../../../shared/workingStatus';
import type { BotGroupWorkTarget } from './useBotGroupWorkTargets';
import { isBotGroupNoReplyText, type BotGroupMemberView, type BotGroupSpeakerActivity, type BotGroupSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { BotGenerationLabel } from './BotGenerationLabel';
import { formatBotGroupElapsed, useBotGroupNow } from './BotGroupElapsed';
import { BotGroupLivePreview } from './BotGroupLivePreview';
import { BotGroupPendingInteraction } from './BotGroupPendingInteraction';
import type { BotGroupRunningStep } from './BotGroupTimelineModel';

export interface BotGroupLiveSpeaker {
  member: BotGroupMemberView;
  displayName: string;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
  target?: BotGroupWorkTarget;
  startedAt?: number;
  stopping?: boolean;
  executionId?: string;
  executionStatus?: 'queued' | 'running' | 'needs_input' | 'stopping';
}

function useSpeakerActivity(speaker: BotGroupLiveSpeaker | undefined) {
  const local = useAgentIslandActivity(speaker?.target ? '' : speaker?.sessionId ?? '');
  const remote = useRemoteSessionActivity(speaker?.sessionId ?? '', speaker?.target?.deviceId);
  return speaker?.target ? remote ? {
    ...remote, workingPhase: readWorkingPhase(remote.workingPhase) ?? undefined,
    startedAtMs: speaker.startedAt ?? null, currentActionSummary: remote.compactDetail, gracefulStopState: 'none',
  } : null : local;
}

/** A speaker active this long earns the progress strip in plain discussion. */
export const BOT_GROUP_PROGRESS_STRIP_DELAY_MS = 3_000;

function pendingBot(speaker: BotGroupLiveSpeaker) {
  const { member } = speaker;
  return { id: member.botId, name: speaker.displayName, avatar: member.avatar, avatarColor: member.avatarColor };
}

/** Brief initial status; longer work moves to the composer progress area. */
export function BotGroupSpeakingLine({ speaker, showStatus = true }: { speaker: BotGroupLiveSpeaker; showStatus?: boolean }) {
  const { t } = useTranslation();
  const { member, sessionId, activity: speakerActivity } = speaker;
  const navigate = useNavigate();
  const live = useSpeakerActivity(speaker);
  const waiting = live?.phase === 'needs-interaction' || speaker.executionStatus === 'needs_input';
  const [mountedAt] = useState(() => Date.now());
  const now = useBotGroupNow(true);
  const since = live?.startedAtMs ?? speaker.startedAt ?? mountedAt;
  if (speakerActivity !== 'planning' && now - since >= BOT_GROUP_PROGRESS_STRIP_DELAY_MS) {
    return <BotGroupSpeakerInteraction speaker={speaker} />;
  }
  return (
    <article data-testid="bot-group-speaking" data-activity={speakerActivity} className="mt-3.5 flex min-w-0 items-start gap-2.5">
      <div className="flex h-5 w-7 shrink-0 items-center justify-end">
        <BotAvatar bot={member} size="xs" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {showStatus ? (
          <p role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-13 leading-5">
            <span className="shrink-0 font-medium text-[var(--text-primary)]">{speaker.displayName}</span>
            {!waiting ? (
              <span className="flex min-w-0 items-center gap-1 text-[var(--text-secondary)]">
                {/* 呼吸只挂在 HTML 包装层上(DESIGN §7:常驻动画 compositor-only)。 */}
                <span aria-hidden className="session-status-breathing inline-flex shrink-0">
                  <Sparkles size={12} />
                </span>
                <span className="min-w-0 truncate">
                  {speakerActivity === 'planning' ? (
                    // The organizer's decision runs outside any Session, so there is no live phase to show.
                    t('bots.groupChat.speaking.planning')
                  ) : (
                    <BotGenerationLabel
                      sessionId={sessionId ?? undefined}
                      remote={speaker.target ? { deviceId: speaker.target.deviceId, botId: speaker.target.botId } : undefined}
                      phase={live?.workingPhase ?? 'processing'}
                      startedAt={live?.startedAtMs ?? null}
                    />
                  )}
                </span>
              </span>
            ) : null}
          </p>
        ) : null}
        {sessionId ? <Button type="button" variant="secondary" tone="quiet" size="sm" compact className="self-start" onClick={() => navigate(standardSessionRoute(sessionId, speaker.target?.deviceId))}>
          {t('bots.groupChat.progress.viewProcess')}
        </Button> : null}
        {sessionId && !speaker.target ? <BotGroupPendingInteraction sessionId={sessionId} bot={pendingBot(speaker)} /> : null}
      </div>
    </article>
  );
}

/** Only a speaker's pending confirmation, for steps whose status lives in the progress strip. */
export function BotGroupSpeakerInteraction({ speaker }: { speaker: BotGroupLiveSpeaker }) {
  if (!speaker.sessionId || speaker.target) return null;
  return (
    <div className="mt-3 pl-[38px]">
      <BotGroupPendingInteraction sessionId={speaker.sessionId} bot={pendingBot(speaker)} />
    </div>
  );
}

/**
 * Fixed above the composer while a plan step runs, or a teammate has been speaking for a few
 * seconds. Remount it (key) when the speaker set changes so 「几秒」 counts from the new turn.
 */
export function BotGroupProgressStrip(props: BotGroupProgressStripProps) {
  const active = props.speakers.filter(speaker => speaker.activity !== 'planning');
  // The control belongs to the whole group, even though it is rendered once on
  // the last row. A different execution may still be stoppable while that row
  // is waiting for its cancel receipt, so the last speaker's state cannot be
  // used as the button's disabled/loading state.
  const hasStoppableExecution = active.some(speaker => !speaker.stopping && speaker.executionStatus !== 'stopping');
  const stopPending = props.stopping || !hasStoppableExecution;
  if (active.length <= 1) return <BotGroupSingleProgressStrip {...props} />;
  return <>{active.map((speaker, index) => <BotGroupSingleProgressStrip
    key={speaker.executionId ?? `${speaker.member.botId}:${speaker.activity}`}
    {...props} step={props.step?.step.botId === speaker.member.botId && speaker.activity === 'step' ? props.step : null} speakers={[speaker]} showStop={index === active.length - 1} stopPending={stopPending}
  />)}</>;
}

interface BotGroupProgressStripProps {
  step: (BotGroupRunningStep & { member: BotGroupMemberView | undefined; displayName: string }) | null;
  speakers: readonly BotGroupLiveSpeaker[];
  onStop: (scope?: 'all') => void;
  canStopAll?: boolean;
  stopping: boolean;
}

function BotGroupSingleProgressStrip({
  step,
  speakers,
  onStop,
  canStopAll = false,
  stopping,
  showStop = true,
  stopPending,
}: BotGroupProgressStripProps & { showStop?: boolean; stopPending?: boolean }) {
  const { t } = useTranslation();
  const [mountedAt] = useState(() => Date.now());
  const navigate = useNavigate();
  const stepSpeaker = step
    ? speakers.find((speaker) => speaker.activity === 'step' && speaker.member.botId === step.step.botId)
      ?? speakers.find((speaker) => speaker.member.botId === step.step.botId)
    : undefined;
  // Deciding about a split is 「正在安排」 in the header and timeline, not speaking: it never
  // pins the strip, so an organizer still deciding after a few seconds is not shown as talking.
  const lead = step ? stepSpeaker : speakers.find((speaker) => speaker.activity !== 'planning');
  const sessionId = lead?.sessionId ?? null;
  const live = useSpeakerActivity(lead);
  const since = live?.startedAtMs ?? lead?.startedAt ?? (step ? step.plan.updatedAt : mountedAt);
  const isStopping = stopping || lead?.stopping === true || (!!live?.gracefulStopState && live.gracefulStopState !== 'none');
  const buttonPending = stopPending ?? isStopping;
  const now = useBotGroupNow(true);
  if (!step && (!lead || now - since < BOT_GROUP_PROGRESS_STRIP_DELAY_MS)) return null;
  const member = step ? step.member : lead?.member;
  const name = step ? step.displayName : lead?.displayName ?? '';
  // A queue turn is someone speaking, not a numbered step of work.
  const workStep = step && step.plan.kind !== 'talk' ? step : null;
  // The Session's compact detail may still be the previous turn's silence marker (NO_REPLY);
  // that is not an action anyone should read.
  const rawAction = live?.currentActionSummary?.trim() || live?.compactDetail?.trim() || '';
  const action = isBotGroupNoReplyText(rawAction) ? '' : rawAction;
  const canView = !!sessionId;
  return (
    <div data-testid="bot-group-work" className="shrink-0 px-5 pt-2">
      <div
        data-testid="bot-group-progress"
        // Process opens the existing task page; the strip stays compact.
        className="mx-auto flex min-w-0 flex-col border border-[var(--border-default)] bg-[var(--surface-elevated)] w-fit max-w-[min(760px,100%)] rounded-full"
      >
        <div className="flex min-h-9 min-w-0 items-center gap-2 py-1 pl-2 pr-1">
          {member ? <BotAvatar bot={member} size="xs" /> : null}
          <p role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1 truncate text-12 leading-5 text-[var(--text-secondary)]">
            {workStep ? (
              <span className="shrink-0 font-medium text-[var(--text-primary)]">
                {t('bots.groupChat.progress.step', { step: workStep.index, total: workStep.total })}
              </span>
            ) : null}
            <span className="min-w-0 truncate">
              {workStep ? ` · ${name} ${workStep.step.task}` : name}
            </span>
            {!workStep || isStopping || live?.phase === 'needs-interaction' || lead?.executionStatus === 'needs_input' ? <span className="min-w-0 truncate">
              {isStopping
                ? t('bots.groupChat.progress.stopping')
                : lead?.executionStatus === 'queued'
                  ? t('bots.groupChat.progress.queued')
                : live?.phase === 'needs-interaction' || lead?.executionStatus === 'needs_input'
                  ? t('bots.groupChat.waitingConfirm', { name: '' })
                  : <BotGenerationLabel sessionId={sessionId ?? undefined} remote={lead?.target ? { deviceId: lead.target.deviceId, botId: lead.target.botId } : undefined} phase={live?.workingPhase ?? 'processing'} startedAt={live?.startedAtMs ?? null} />}
            </span> : null}
            <span className="shrink-0 tabular-nums">
              {' · '}
              {t('bots.groupChat.progress.elapsed', { time: formatBotGroupElapsed(now - since, t) })}
            </span>
          </p>
          <span className="flex shrink-0 items-center gap-1">
            {canView ? (
              <Button type="button" variant="secondary" tone="quiet" size="sm" compact onClick={() => sessionId && navigate(standardSessionRoute(sessionId, lead?.target?.deviceId))}>
                {t('bots.groupChat.progress.viewProcess')}
              </Button>
            ) : null}
            {!showStop ? null : canStopAll ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="secondary" tone="quiet" size="sm" compact loading={buttonPending} className="text-[var(--text-danger)]">
                    {t('bots.groupChat.progress.stop')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="min-w-[220px]">
                  <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => onStop()}>
                    {t('bots.groupChat.progress.stopMine')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={cn(MENU_ITEM_CLASS, 'h-auto items-start py-2')} onSelect={() => onStop('all')}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[var(--text-danger)]">{t('bots.groupChat.progress.stopAll')}</span>
                      <span className="text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">{t('bots.groupChat.progress.stopAllHint')}</span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                type="button"
                variant="secondary"
                tone="quiet"
                size="sm"
                compact
                loading={buttonPending}
                onClick={() => onStop()}
                className="text-[var(--text-danger)]"
              >
                {t('bots.groupChat.progress.stop')}
              </Button>
            )}
          </span>
        </div>
      </div>
      {action ? <p data-testid="bot-group-work-action" className="mx-auto mt-1 max-w-[760px] truncate px-2 text-center text-13 leading-5 text-[var(--text-secondary)]" title={action}>{action}</p> : null}
      {lead?.target ? <p className="mt-1 text-center text-12 leading-5 text-[var(--text-secondary)]">{lead.target.deviceName}</p> : null}
      {sessionId && !lead?.target && live?.phase === 'running' ? <BotGroupLivePreview sessionId={sessionId} className="mx-auto mt-1 max-w-[760px] px-2" /> : null}
    </div>
  );
}

/** Header status: who is doing which step, or who is speaking or planning. */
export function botGroupHeaderStatus(
  group: Pick<BotGroupSummary, 'speakingBotIds' | 'planningBotId' | 'openPlan' | 'members'>,
  displayName: (member: BotGroupMemberView) => string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const nameOf = (botId: string | null) => {
    const member = group.members.find((candidate) => candidate.botId === botId);
    return member ? displayName(member) : '';
  };
  const plan = group.openPlan;
  if (plan?.status === 'running' && plan.currentStep !== null && plan.currentStepStatus === 'running') {
    // A queue's turn is someone speaking, not a step of work.
    if (plan.kind === 'talk') return t('bots.groupChat.header.speaking', { name: plan.currentBotName?.trim() || '' });
    return t('bots.groupChat.header.stepRunning', { name: plan.currentBotName?.trim() || '', step: plan.currentStep + 1 });
  }
  if (group.planningBotId) return t('bots.groupChat.header.planning', { name: nameOf(group.planningBotId) });
  const speaker = group.speakingBotIds[0];
  if (speaker) return t('bots.groupChat.header.speaking', { name: nameOf(speaker) });
  return null;
}

export function BotGroupHeaderStatusText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1 text-[var(--status-bar-accent)]', className)}>
      <span aria-hidden className="session-status-breathing inline-flex shrink-0">
        <Sparkles size={11} />
      </span>
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
