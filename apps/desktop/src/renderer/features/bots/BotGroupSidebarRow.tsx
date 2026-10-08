/**
 * 统一伙伴列表里的群聊行，和伙伴私聊共同按最新消息排序。
 *
 * 群行与伙伴行同一套 IM 行几何（见 __tests__/botsSidebarSpacing.test.ts）：左侧两位
 * 成员的叠放头像，第一行群名，第二行最近一条消息「作者：内容」。有伙伴正在发言时，
 * 第二行临时让位给运行中标记（橙色 sparkles + 发言伙伴的工作状态，DESIGN.md §2
 * Thinking Orange 的侧栏运行态），一轮结束就落回最近消息。
 *
 * 分工（docs/product-rules/bot-group-chat.md §7）：负责人正在安排时写「谁 正在安排…」，
 * 某一步进行中写「分工 k/n · 谁 正在做」，两者同样用运行中标记；安排待开始、做完一步
 * 等继续或没做完时，第二行换成对应的提示，提醒用户回来看看。
 */
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupDuoAvatar } from './BotGroupAvatars';
import { isBotGroupLaneSession } from './botGroupLane';
import {
  botGroupPreviewLine,
  botGroupSidebarPlanPreview,
  isRunningBotGroupSidebarPreview,
  type BotGroupSidebarPlanPreview,
} from './botGroupPresentation';
import { isBotGroupUnread } from './botReadState';
import { NavigationCountBadge } from '@/components/sidebar/NavigationCountBadge';
import { formatBotListTimestamp } from './botListDisplay';
import type { BotProfile } from './botStore';

/**
 * The speaking Bot's active group lane, if the activity mirror has one. A Bot
 * can sit in several groups; any active lane is the one it is speaking in.
 */
function speakingLaneActivity(
  bot: BotProfile | undefined,
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>,
): AgentIslandSessionActivity | undefined {
  if (!bot) return undefined;
  return bot.sessions
    .filter(isBotGroupLaneSession)
    .map((session) => islandActivity.get(session.id))
    .find((activity) => activity?.phase === 'running' || activity?.phase === 'needs-interaction');
}

export function BotGroupSidebarRow({
  group,
  bots,
  islandActivity,
  now,
  selected,
  onOpenGroup,
}: {
  group: BotGroupSummary;
  bots: readonly BotProfile[];
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>;
  now: number;
  selected: boolean;
  onOpenGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation();

  const previewText = (group: BotGroupSummary, plan: BotGroupSidebarPlanPreview | null): string => {
    if (plan?.kind === 'proposed') {
      return plan.organizerName
        ? t('bots.groupChat.sidebar.planProposed', { name: plan.organizerName })
        : t('bots.groupChat.sidebar.planProposedAnonymous');
    }
    if (plan?.kind === 'step-done') return t('bots.groupChat.sidebar.planStepDone', { name: plan.botName });
    if (plan?.kind === 'step-failed') return t('bots.groupChat.sidebar.planStepFailed', { name: plan.botName });
    if (plan?.kind === 'waiting') return t('bots.groupChat.sidebar.planWaitingAnonymous');
    const last = group.lastMessage;
    if (!last) return t('bots.groupChat.sidebar.empty');
    const text = botGroupPreviewLine(last.preview);
    if (last.authorKind === 'user' && last.isSelf !== false) return t('bots.groupChat.sidebar.previewYou', { text });
    if (last.authorName.trim()) {
      return t('bots.groupChat.sidebar.preview', { name: last.authorName.trim(), text });
    }
    return text;
  };

  const renderSubtitle = (group: BotGroupSummary, mutedClass: string): ReactNode => {
    // Several Bots may think at once in a broadcast round's first circle.
    const speakers = group.speakingBotIds
      .map((botId) => group.members.find((member) => member.botId === botId))
      .filter((member): member is BotGroupSummary['members'][number] => member !== undefined);
    const plan = botGroupSidebarPlanPreview(group);
    const activities = speakers.map((member) =>
      speakingLaneActivity(bots.find((bot) => bot.id === member.botId), islandActivity));
    const activity = activities[0];
    const waiting = activities.some((item) => item?.phase === 'needs-interaction');
    const names = speakers.map((member) => member.name).join(t('bots.groupChat.memberSeparator'));
    // Planning and a step in progress read as one line; a step waiting for the user's
    // go-ahead keeps the confirmation hint below instead.
    const planLine =
      !waiting && isRunningBotGroupSidebarPreview(plan)
        ? plan.kind === 'planning'
          ? t('bots.groupChat.sidebar.planPlanning', { name: plan.botName || names })
          : plan.step !== null && plan.total > 0
            ? t('bots.groupChat.sidebar.planRunning', {
                step: plan.step,
                total: plan.total,
                name: plan.botName || names,
              })
            : t('bots.groupChat.sidebar.planRunningNoStep', { name: plan.botName || names })
        : null;
    if (speakers.length === 0 && planLine === null) {
      const text = previewText(group, plan);
      return (
        <span className={cn('min-w-0 flex-1 truncate text-12 leading-4', mutedClass)} title={text}>
          {text}
        </span>
      );
    }
    return (
      <span
        data-testid="bot-group-running"
        className="flex min-w-0 flex-1 items-center gap-1 text-12 leading-4 text-[var(--status-bar-accent)]"
      >
        {/* 呼吸只挂在 HTML 包装层上(engineering-conventions §7:常驻动画 compositor-only)。 */}
        <span aria-hidden className="session-status-breathing inline-flex shrink-0">
          <Sparkles size={11} />
        </span>
        {planLine !== null ? (
          <span className="min-w-0 truncate" title={planLine}>
            {planLine}
          </span>
        ) : (
          <>
            <span className="shrink-0">{names}</span>
            <span className="min-w-0 truncate">
              {waiting ? (
                t('bots.groupChat.sidebar.waiting')
              ) : (
                <BotGenerationLabel
                  sessionId={activity?.sessionId}
                  phase={activity?.workingPhase ?? 'thinking'}
                  startedAt={activity?.startedAtMs ?? null}
                />
              )}
            </span>
          </>
        )}
      </span>
    );
  };

  const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
  const timestamp = formatBotListTimestamp(
    group.speakingBotIds.length > 0 ? now : group.lastMessage?.createdAt ?? group.updatedAt,
    now,
  );
  return (
    <button
      key={group.id}
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={() => onOpenGroup(group.id)}
      className={cn(
        'group flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
          : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
      )}
    >
      <BotGroupDuoAvatar members={group.members} selected={selected} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate text-14 leading-5" title={group.name}>
          {group.name}
        </span>
        <span className="flex min-w-0 items-center gap-2">{renderSubtitle(group, mutedClass)}</span>
      </span>
      <span
        className={cn(
          'w-10 shrink-0 self-start pt-0.5 text-right text-11 tabular-nums',
          mutedClass,
        )}
      >
        {timestamp}
        <NavigationCountBadge count={isBotGroupUnread(group) ? 1 : 0} label={t('sidebar.teammateUnreadCount', { count: 1 })} className="ml-auto mt-1 w-fit" />
      </span>
    </button>
  );
}
