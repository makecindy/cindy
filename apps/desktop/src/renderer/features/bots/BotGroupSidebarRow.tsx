import { companionDragProps } from './companionDragProps';
import { SIDEBAR_LIST_ROW_ACTIVE_CLASS, SIDEBAR_LIST_ROW_HEIGHT_CLASS } from '@/features/cc-agent/sidebar/listRowStyle';
import { TeammateRowStatus } from './TeammateStatusDot';
import { groupTeammateStatus } from './teammateRosterStatus';
/**
 * 统一伙伴列表里的群聊行，和伙伴私聊共同按最新消息排序。
 *
 * 群行与伙伴行同一套 IM 行几何（见 __tests__/teammatesSectionSpacing.test.ts）：左侧按人数
 * 显示组合头像，第一行群名，第二行最近一条消息「作者：内容」。有伙伴正在发言时，
 * 第二行临时让位给运行中标记（橙色 sparkles + 发言伙伴的工作状态，DESIGN.md §2
 * Thinking Orange 的侧栏运行态），一轮结束就落回最近消息。
 *
 * 分工（docs/product-rules/bot-group-chat.md §7）：负责人正在安排时写「谁 正在安排…」，
 * 某一步进行中写「分工 k/n · 谁 正在做」，两者同样用运行中标记；安排待开始、做完一步
 * 等继续或没做完时，第二行换成对应的提示，提醒用户回来看看。
 *
 * 未读角标是真实条数：main 随摘要给出最近（至多 99 条）别人发来的消息时间
 * （`incomingMessageTimes`），与本机读位比较；旧宿主没有这份列表时只显示 1。多人群里
 * 别人带来的伙伴按「伙伴名 (主人昵称)」显示（与群聊页同一规则）。
 */
import { useId, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from 'react';
import { MessagesSquare, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupSidebarAvatar } from './BotGroupAvatars';
import { isBotGroupLaneSession } from './botGroupLane';
import {
  botGroupNoticeKey,
  botGroupActivityAt,
  botGroupPreviewLine,
  botGroupSidebarPlanPreview,
  isRunningBotGroupSidebarPreview,
  type BotGroupSidebarPlanPreview,
} from './botGroupPresentation';
import { botGroupMemberDisplayName } from './BotGroupTimelineModel';
import { botGroupUnreadCount } from './botReadState';
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
  onContextMenu,
  onKeyDown,
  children,
}: {
  group: BotGroupSummary;
  bots: readonly BotProfile[];
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>;
  now: number;
  selected: boolean;
  onOpenGroup: (groupId: string, reply?: { messageId: string; threadRootId: string }) => void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const subtitleId = useId();

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
    if (last.authorKind === 'system') {
      const key = botGroupNoticeKey(last.noticeCode ?? null, false);
      return key ? t(key, { name: last.authorName }) : botGroupPreviewLine(last.preview);
    }
    // A share names who posted it; the card's own text is never quoted here.
    if (last.threadShare) {
      return last.authorKind === 'user' && last.isSelf !== false
        ? t('bots.groupChat.sidebar.sharedReplyYou')
        : t('bots.groupChat.sidebar.sharedReply', { name: last.authorName.trim() });
    }
    const text = botGroupPreviewLine(last.preview);
    if (last.authorKind === 'user' && last.isSelf !== false) return t('bots.groupChat.sidebar.previewYou', { text });
    if (last.authorName.trim()) {
      return t('bots.groupChat.sidebar.preview', { name: last.authorName.trim(), text });
    }
    return text;
  };

  const renderPreview = (plan: BotGroupSidebarPlanPreview | null, mutedClass: string): ReactNode => {
    const text = previewText(group, plan);
    // Plan prompts occupy the subtitle too; their click must still open the group.
    const planPrompt = plan && ['proposed', 'step-done', 'step-failed', 'waiting'].includes(plan.kind);
    const last = group.lastMessage;
    if (!planPrompt && last?.threadRootId) {
      const source = t('bots.groupChat.sidebar.threadReply');
      const label = `${source} · ${text}`;
      const content = <>
        <span className="inline-flex shrink-0 items-center gap-1 text-11 leading-[1.455]">
          <MessagesSquare size={12} aria-hidden />{source}<span aria-hidden>·</span>
        </span>
        <span className="min-w-0 truncate">{text}</span>
      </>;
      // Older projections without a message ID can label the source but cannot promise a jump.
      if (last.messageId) return <button type="button" title={label}
        aria-label={`${t('bots.groupChat.server.thread.viewThread')}: ${label}`}
        onContextMenu={onContextMenu} onKeyDown={onKeyDown}
        onClick={event => {
          event.stopPropagation();
          onOpenGroup(group.id, { messageId: last.messageId!, threadRootId: last.threadRootId! });
        }}
        className={cn('pointer-events-auto relative -mb-2 flex min-h-6 min-w-0 flex-1 items-start gap-1 text-left text-12 leading-[1.3334] outline-none hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring', mutedClass)}>
        {content}
      </button>;
      return <span title={label} className={cn('flex min-w-0 flex-1 items-center gap-1 text-12 leading-[1.3334]', mutedClass)}>{content}</span>;
    }
    return <span className={cn('min-w-0 flex-1 truncate text-12 leading-4', mutedClass)} title={text}>{text}</span>;
  };

  const renderSubtitle = (group: BotGroupSummary, mutedClass: string): ReactNode => {
    if (group.archived) return renderPreview(null, mutedClass);
    // Several Bots may think at once in a broadcast round's first circle.
    const speakingIds = group.round?.speakers.filter(speaker => speaker.executionStatus !== 'queued').map(speaker => speaker.botId) ?? group.speakingBotIds;
    const speakers = speakingIds
      .map((botId) => group.members.find((member) => member.botId === botId))
      .filter((member): member is BotGroupSummary['members'][number] => member !== undefined);
    const plan = botGroupSidebarPlanPreview(group);
    const executions = group.round?.speakers.filter(speaker => speaker.activity !== 'planning');
    const queued = executions?.find(speaker => speaker.executionStatus === 'queued');
    const queuedStep = executions?.some(speaker => speaker.activity === 'step' && speaker.executionStatus === 'queued')
      && !executions?.some(speaker => speaker.activity === 'step' && speaker.executionStatus !== 'queued');
    if (queued && executions?.every(speaker => speaker.executionStatus === 'queued') && !group.planningBotId) {
      const member = group.members.find(member => member.botId === queued.botId);
      return <span data-testid="bot-group-running" className="min-w-0 flex-1 truncate text-12 leading-4 text-[var(--status-bar-accent)]">
        {t('bots.groupChat.header.queued', { name: member ? botGroupMemberDisplayName(member) : '' })}
      </span>;
    }
    const activities = speakers.map((member) =>
      speakingLaneActivity(bots.find((bot) => bot.id === member.botId), islandActivity));
    const activity = activities[0];
    const waiting = activities.some((item) => item?.phase === 'needs-interaction');
    const names = speakers.map(botGroupMemberDisplayName).join(t('bots.groupChat.memberSeparator'));
    // Planning and a step in progress read as one line; a step waiting for the user's
    // go-ahead keeps the confirmation hint below instead.
    const planLine =
      !waiting && isRunningBotGroupSidebarPreview(plan) && !(plan.kind === 'running' && queuedStep)
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
      return renderPreview(plan, mutedClass);
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
          <span className="min-w-0 flex-1 truncate" title={names}>
            {names}{' '}
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
        )}
      </span>
    );
  };

  const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
  const unread = botGroupUnreadCount(group);
  const timestamp = formatBotListTimestamp(
    !group.archived && group.speakingBotIds.length > 0 ? now : botGroupActivityAt(group),
    now,
    t,
  );
  return (
    <div className="relative">
    <div
      data-bot-group-id={group.id}
      onClick={() => onOpenGroup(group.id)}
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        SIDEBAR_LIST_ROW_HEIGHT_CLASS,
        selected
          ? SIDEBAR_LIST_ROW_ACTIVE_CLASS
          : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
      )}
    >
      {/* Sibling hit targets avoid nesting the topic button inside the whole-row button. */}
      <button type="button" {...companionDragProps(`/bots/groups/${encodeURIComponent(group.id)}`, group.name)} onContextMenu={onContextMenu} onKeyDown={onKeyDown} aria-label={group.name} aria-describedby={subtitleId} aria-current={selected ? 'page' : undefined}
        aria-haspopup={onContextMenu ? 'menu' : undefined}
        className="absolute inset-0 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      <span className="pointer-events-none relative flex shrink-0"><BotGroupSidebarAvatar members={group.members} />
      </span>
      <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-14 leading-5" title={group.name}>{group.name}</span>
          {group.archived && <span className={cn('shrink-0 text-11 leading-4', mutedClass)}>{t('bots.archived')}</span>}
          <span
            data-teammate-timestamp
            className={cn(
              'ml-auto min-w-10 shrink-0 whitespace-nowrap text-right text-11 leading-4 tabular-nums',
              mutedClass,
            )}
          >
            {timestamp}
          </span>
        </span>
        {/* 未读数字/状态点占自己的列：副标题横贯整行，绝对定位的角标会压在预览文字上。 */}
        <span id={subtitleId} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
          {renderSubtitle(group, mutedClass)}
          <TeammateRowStatus status={groupTeammateStatus(group, bots, islandActivity, unread > 0)} groupUnread={unread} mentioned={unread > 0 && group.serverUnread?.mentioned === true} inline />
        </span>
      </span>
    </div>
    {children}
    </div>
  );
}
