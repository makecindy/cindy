/**
 * 群聊的「正在进行」：
 *
 * - 时间线末尾每位正在发言的伙伴一行扁平状态「LiZi 正在想…」，本机能读到流式正文时下面
 *   跟最后两行（逐字出来的感觉）；等确认时放确认卡。负责人还在判断要不要分工时写「正在安排…」。
 * - 输入框上方的进行中条（不随时间线滚走）：分工某一步在做，或某位伙伴说了超过三秒时出现，
 *   写「第 k/n 步 · 谁 做什么 · 已做多久 · 当前动作」，带「看过程」（本机能读到这条专线时）
 *   与「停止」。分工进行中它替代时间线末尾的发言行。
 * - 顶栏右侧的一句状态：「Dash 正在做第 2 步」「Dash 正在说…」「LiZi 正在安排…」。
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
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
}

/** A speaker active this long earns the progress strip in plain discussion. */
export const BOT_GROUP_PROGRESS_STRIP_DELAY_MS = 3_000;

function pendingBot(speaker: BotGroupLiveSpeaker) {
  const { member } = speaker;
  return { id: member.botId, name: speaker.displayName, avatar: member.avatar, avatarColor: member.avatarColor };
}

/** The flat 「LiZi 正在…」 line at the end of the timeline, with the live text under it. */
export function BotGroupSpeakingLine({ speaker, showStatus = true }: { speaker: BotGroupLiveSpeaker; showStatus?: boolean }) {
  const { t } = useTranslation();
  const { member, sessionId, activity: speakerActivity } = speaker;
  const live = useAgentIslandActivity(sessionId ?? '');
  const waiting = live?.phase === 'needs-interaction';
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
              <span className="flex min-w-0 items-center gap-1 text-[var(--status-bar-accent)]">
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
                      phase={live?.workingPhase ?? 'thinking'}
                      startedAt={live?.startedAtMs ?? null}
                    />
                  )}
                </span>
              </span>
            ) : null}
          </p>
        ) : null}
        {sessionId && live?.phase === 'running' ? <BotGroupLivePreview sessionId={sessionId} /> : null}
        {sessionId ? <BotGroupPendingInteraction sessionId={sessionId} bot={pendingBot(speaker)} /> : null}
      </div>
    </article>
  );
}

/** Only a speaker's pending confirmation, for steps whose status lives in the progress strip. */
export function BotGroupSpeakerInteraction({ speaker }: { speaker: BotGroupLiveSpeaker }) {
  if (!speaker.sessionId) return null;
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
export function BotGroupProgressStrip({
  step,
  speakers,
  onStop,
  stopping,
}: {
  step: (BotGroupRunningStep & { member: BotGroupMemberView | undefined; displayName: string }) | null;
  speakers: readonly BotGroupLiveSpeaker[];
  onStop: () => void;
  stopping: boolean;
}) {
  const { t } = useTranslation();
  const [mountedAt] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const stepSpeaker = step
    ? speakers.find((speaker) => speaker.activity === 'step' && speaker.member.botId === step.step.botId)
      ?? speakers.find((speaker) => speaker.member.botId === step.step.botId)
    : undefined;
  // Deciding about a split is 「正在安排」 in the header and timeline, not speaking: it never
  // pins the strip, so an organizer still deciding after a few seconds is not shown as talking.
  const lead = step ? stepSpeaker : speakers.find((speaker) => speaker.activity !== 'planning');
  const sessionId = lead?.sessionId ?? null;
  const live = useAgentIslandActivity(sessionId ?? '');
  const since = live?.startedAtMs ?? (step ? step.plan.updatedAt : mountedAt);
  const now = useBotGroupNow(true);
  if (!step && (!lead || now - since < BOT_GROUP_PROGRESS_STRIP_DELAY_MS)) return null;
  const member = step ? step.member : lead?.member;
  const name = step ? step.displayName : lead?.displayName ?? '';
  // The Session's compact detail may still be the previous turn's silence marker (NO_REPLY);
  // that is not an action anyone should read.
  const rawAction = live?.compactDetail?.trim() || '';
  const action = isBotGroupNoReplyText(rawAction) ? '' : rawAction;
  const canView = !!sessionId && live?.phase === 'running';
  return (
    <div className="shrink-0 px-5 pt-2">
      <div
        data-testid="bot-group-progress"
        className="mx-auto flex w-full max-w-[760px] flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      >
        <div className="flex min-h-9 min-w-0 items-center gap-2 px-3 py-1.5">
          {member ? <BotAvatar bot={member} size="xs" /> : null}
          <p role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1 truncate text-12 leading-5 text-[var(--text-secondary)]">
            {step ? (
              <span className="shrink-0 font-medium text-[var(--text-primary)]">
                {t('bots.groupChat.progress.step', { step: step.index, total: step.total })}
              </span>
            ) : null}
            <span className="min-w-0 truncate">
              {step ? ` · ${name} ${step.step.task}` : t('bots.groupChat.progress.speaking', { name })}
            </span>
            <span className="shrink-0 tabular-nums">
              {' · '}
              {t('bots.groupChat.progress.elapsed', { time: formatBotGroupElapsed(now - since, t) })}
            </span>
            {action ? (
              <span className="min-w-0 truncate text-[var(--status-bar-accent)]">{` · ${action}`}</span>
            ) : null}
          </p>
          <span className="flex shrink-0 items-center gap-1">
            {canView ? (
              <Button type="button" variant="secondary" tone="quiet" size="sm" compact aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {t(expanded ? 'bots.groupChat.progress.hideProcess' : 'bots.groupChat.progress.viewProcess')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              compact
              loading={stopping}
              onClick={onStop}
              className="text-[var(--text-danger)]"
            >
              {t('bots.groupChat.progress.stop')}
            </Button>
          </span>
        </div>
        {expanded && canView && sessionId ? (
          <div className="flex min-w-0 flex-col gap-1 border-t border-[var(--border-default)] px-3 py-2">
            {action ? (
              <p className="min-w-0 truncate text-12 text-[var(--status-bar-accent)]">{action}</p>
            ) : null}
            <BotGroupLivePreview sessionId={sessionId} lines={8} className="text-12" />
          </div>
        ) : null}
      </div>
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
