/**
 * 伙伴侧栏里的「群聊」分组：小节头（带新建按钮）+ 群行。
 *
 * 群行与伙伴行同一套 IM 行几何（见 __tests__/botsSidebarSpacing.test.ts）：左侧两位
 * 成员的叠放头像，第一行群名，第二行最近一条消息「作者：内容」。有伙伴正在发言时，
 * 第二行临时让位给运行中标记（橙色 sparkles + 发言伙伴的工作状态，DESIGN.md §2
 * Thinking Orange 的侧栏运行态），一轮结束就落回最近消息。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Sparkles, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupCreateDialog } from './BotGroupCreateDialog';
import { BotGroupDuoAvatar } from './BotGroupAvatars';
import { isBotGroupLaneSession } from './botGroupLane';
import { botGroupPreviewLine, sortBotGroups } from './botGroupPresentation';
import { useBotGroupList } from './botGroupStore';
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

export function BotGroupSidebarSection({
  bots,
  islandActivity,
  now,
  selectedGroupId,
  onOpenGroup,
}: {
  bots: readonly BotProfile[];
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>;
  now: number;
  selectedGroupId: string | undefined;
  onOpenGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const { groups } = useBotGroupList();
  const sorted = useMemo(() => sortBotGroups(groups), [groups]);
  const [createOpen, setCreateOpen] = useState(false);

  const previewText = (group: BotGroupSummary): string => {
    const last = group.lastMessage;
    if (!last) return t('bots.groupChat.sidebar.empty');
    const text = botGroupPreviewLine(last.preview);
    if (last.authorKind === 'user') return t('bots.groupChat.sidebar.previewYou', { text });
    if (last.authorKind === 'bot' && last.authorName.trim()) {
      return t('bots.groupChat.sidebar.preview', { name: last.authorName.trim(), text });
    }
    return text;
  };

  const renderSubtitle = (group: BotGroupSummary, mutedClass: string): ReactNode => {
    // Several Bots may think at once in a broadcast round's first circle.
    const speakers = group.speakingBotIds
      .map((botId) => group.members.find((member) => member.botId === botId))
      .filter((member): member is BotGroupSummary['members'][number] => member !== undefined);
    const speaker = speakers[0];
    if (!speaker) {
      const text = previewText(group);
      return (
        <span className={cn('min-w-0 flex-1 truncate text-12 leading-4', mutedClass)} title={text}>
          {text}
        </span>
      );
    }
    const activities = speakers.map((member) =>
      speakingLaneActivity(bots.find((bot) => bot.id === member.botId), islandActivity));
    const activity = activities[0];
    const waiting = activities.some((item) => item?.phase === 'needs-interaction');
    return (
      <span
        data-testid="bot-group-running"
        className="flex min-w-0 flex-1 items-center gap-1 text-12 leading-4 text-[var(--status-bar-accent)]"
      >
        {/* 呼吸只挂在 HTML 包装层上(engineering-conventions §7:常驻动画 compositor-only)。 */}
        <span aria-hidden className="session-status-breathing inline-flex shrink-0">
          <Sparkles size={11} />
        </span>
        <span className="shrink-0">
          {speakers.map((member) => member.name).join(t('bots.groupChat.memberSeparator'))}
        </span>
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
      </span>
    );
  };

  return (
    <section className="mt-4" aria-labelledby="bot-group-sidebar-title">
      {/* 小节头与「伙伴」小节同一套对齐:容器 12px + 行内 10px。 */}
      <div className="flex items-center justify-between px-2.5 pb-2">
        <div className="flex items-center gap-2 text-12 font-medium text-[var(--sidebar-list-muted)]">
          <Users size={14} aria-hidden />
          <span id="bot-group-sidebar-title">{t('bots.groupChat.sidebar.title')}</span>
        </div>
        <Tip text={t('bots.groupChat.create.title')}>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]"
            aria-label={t('bots.groupChat.create.title')}
          >
            <Plus size={15} />
          </button>
        </Tip>
      </div>
      {sorted.length > 0 ? (
        <div className="flex flex-col gap-1">
          {sorted.map((group) => {
            const selected = group.id === selectedGroupId;
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
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {createOpen ? (
        <BotGroupCreateDialog
          onOpenChange={(open) => {
            if (!open) setCreateOpen(false);
          }}
          onCreated={(groupId) => {
            setCreateOpen(false);
            onOpenGroup(groupId);
          }}
        />
      ) : null}
    </section>
  );
}
