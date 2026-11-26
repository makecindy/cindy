import { companionDragProps } from './companionDragProps';
import { SIDEBAR_LIST_ROW_ACTIVE_CLASS, SIDEBAR_LIST_ROW_HEIGHT_CLASS } from '@/features/cc-agent/sidebar/listRowStyle';
import { TeammateRowStatus } from './TeammateStatusDot';
import { groupTeammateStatus } from './teammateRosterStatus';
/**
 * 统一伙伴列表里的群聊行，和伙伴私聊共同按最新消息排序。
 *
 * 群行与伙伴行同一套 IM 行几何（见 __tests__/teammatesSectionSpacing.test.ts）：左侧按人数
 * 显示组合头像，第一行群名，第二行始终展示最近一条消息「作者：内容」；群内伙伴在执行时
 * 不在外边展示运行中状态，时间也保持最近消息时刻。
 *
 * 仅在需要用户操作时替换副标题：本机伙伴等待用户确认（needs-interaction），或分工安排
 * 待开始、做完一步等继续／没做完时，提示用户回来看看。
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
import { BotGroupSidebarAvatar } from './BotGroupAvatars';
import { BotGroupExternalBadge } from './BotGroupExternalBadge';
import { isBotGroupLaneSession } from './botGroupLane';
import {
  botGroupNoticeKey,
  botGroupActivityAt,
  botGroupPreviewLine,
  botGroupSidebarPlanPreview,
  type BotGroupSidebarPlanPreview,
} from './botGroupPresentation';
import { botGroupMemberDisplayName } from './BotGroupTimelineModel';
import { botGroupUnreadCount } from './botReadState';
import { formatBotListTimestamp } from './botListDisplay';
import type { BotProfile } from './botStore';

/**
 * A speaking Bot's group lane waiting on user confirmation, if any.
 */
function waitingLaneActivity(
  bot: BotProfile | undefined,
  groupId: string,
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>,
): AgentIslandSessionActivity | undefined {
  if (!bot) return undefined;
  return bot.sessions
    .filter((session) => isBotGroupLaneSession(session) && (!session.groupId || session.groupId === groupId))
    .map((session) => islandActivity.get(session.id))
    .find((activity) => activity?.phase === 'needs-interaction');
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
  onOpenGroup: (groupId: string) => void;
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
      return <span title={label} className={cn('flex min-w-0 flex-1 items-center gap-1 text-12 leading-[1.3334]', mutedClass)}>
        <span className="inline-flex shrink-0 items-center gap-1 text-11 leading-[1.455]">
          <MessagesSquare size={12} aria-hidden />{source}<span aria-hidden>·</span>
        </span>
        <span className="min-w-0 truncate">{text}</span>
      </span>;
    }
    return <span className={cn('min-w-0 flex-1 truncate text-12 leading-4', mutedClass)} title={text}>{text}</span>;
  };

  const renderSubtitle = (group: BotGroupSummary, mutedClass: string): ReactNode => {
    if (group.archived) return renderPreview(null, mutedClass);
    // In-progress group executions stay inside the chat so the sidebar keeps showing the
    // latest message; only a local teammate blocked on user confirmation surfaces a hint.
    const speakingIds = group.round?.speakers.filter(speaker => speaker.executionStatus !== 'queued').map(speaker => speaker.botId) ?? group.speakingBotIds;
    const waitingSpeakers = speakingIds
      .map((botId) => group.members.find((member) => member.botId === botId))
      .filter((member): member is BotGroupSummary['members'][number] => member !== undefined)
      .filter((member) => Boolean(waitingLaneActivity(bots.find((bot) => bot.id === member.botId), group.id, islandActivity)));
    if (waitingSpeakers.length > 0) {
      const names = waitingSpeakers.map(botGroupMemberDisplayName).join(t('bots.groupChat.memberSeparator'));
      return (
        <span
          data-testid="bot-group-running"
          className="flex min-w-0 flex-1 items-center gap-1 text-12 leading-4 text-[var(--status-bar-accent)]"
        >
          {/* 呼吸只挂在 HTML 包装层上(engineering-conventions §7:常驻动画 compositor-only)。 */}
          <span aria-hidden className="session-status-breathing inline-flex shrink-0">
            <Sparkles size={11} />
          </span>
          <span className="min-w-0 flex-1 truncate" title={names}>
            {names}{' '}{t('bots.groupChat.sidebar.waiting')}
          </span>
        </span>
      );
    }
    return renderPreview(botGroupSidebarPlanPreview(group), mutedClass);
  };

  const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
  const unread = botGroupUnreadCount(group);
  const timestamp = formatBotListTimestamp(botGroupActivityAt(group), now, t);
  const isExternalGroup = group.conversationKind !== 'direct' && group.external === true;
  const rowLabel = isExternalGroup ? `${group.name}, ${t('bots.groupChat.externalBadge')}` : group.name;
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
      <button type="button" {...companionDragProps(`/bots/groups/${encodeURIComponent(group.id)}`, group.name)} onContextMenu={onContextMenu} onKeyDown={onKeyDown} aria-label={rowLabel} aria-describedby={subtitleId} aria-current={selected ? 'page' : undefined}
        aria-haspopup={onContextMenu ? 'menu' : undefined}
        className="absolute inset-0 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      <span className="pointer-events-none relative flex shrink-0"><BotGroupSidebarAvatar members={group.members} />
      </span>
      <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-14 leading-5" title={group.name}>{group.name}</span>
          {isExternalGroup && <BotGroupExternalBadge />}
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
