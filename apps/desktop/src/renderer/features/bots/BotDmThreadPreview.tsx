/**
 * 私聊话题在主对话里的入口行（docs/product-rules/cindy-bots-runtime.md「私聊话题」），
 * 与群聊话题入口同一外观。单独成文件：消息气泡引用它，不能顺带引入话题面板（面板内嵌任务视图）。
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatAbsolute, useRelativeTime } from '@/hooks/useRelativeTime';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';
import type { BotDmThreadSummary } from '../../../shared/botDmThread';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { BotAvatar } from './BotAvatar';

const groupKey = (name: string) => `bots.groupChat.server.${name}`;
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/**
 * One line under a root message, flush with its bubble: the companion, how many messages the topic
 * has and when the last one came — or a dot while a companion reply there is still unread.
 */
export function BotDmThreadPreview({ thread, bot, unread, onOpen, align = 'left' }: {
  thread: BotDmThreadSummary;
  /** Flush with the bubble: the companion's on the left, the owner's own on the right. */
  align?: 'left' | 'right';
  bot: Pick<BotChatIdentity, 'name' | 'avatar' | 'avatarColor'>;
  unread: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const latestAt = thread.lastReplyAt ? new Date(thread.lastReplyAt).toISOString() : undefined;
  const relative = useRelativeTime(latestAt, { hovered });
  const count = thread.replyCount;
  return (
    <button type="button" data-dm-thread-preview={thread.rootClientId} {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      aria-label={[t(groupKey('thread.open'), { count }), ...(unread ? [t('bots.dmThread.newReply')] : [])].join(', ')}
      onClick={onOpen} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      className={cn('group/thread mt-1 flex min-h-6 min-w-0 max-w-full select-none items-center gap-2 rounded-full text-left text-13 leading-5', align === 'right' ? 'self-end' : 'self-start', FOCUS)}>
      <span aria-hidden className="flex shrink-0">
        <BotAvatar size="xs" className="h-[18px] w-[18px] text-11"
          bot={{ name: bot.name, avatar: bot.avatar ?? null, avatarColor: bot.avatarColor ?? null }} />
      </span>
      <span className="shrink-0 font-medium text-[var(--text-primary)] underline-offset-[3px] group-hover/thread:underline">
        {t(groupKey('replyCount'), { count })}
      </span>
      {/* Unread replaces the last-reply time: a dot in the unread color, the words stay neutral. */}
      {unread ? (
        <span className="flex min-w-0 items-center gap-1.5 text-12 font-medium text-[var(--text-primary)]" data-dm-thread-unread="">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]" />
          <span className="truncate">{t('bots.dmThread.newReply')}</span>
        </span>
      ) : relative ? (
        <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" title={formatAbsolute(latestAt)}>
          {t(groupKey('thread.lastReply'), { time: relative })}
        </span>
      ) : null}
      <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover/thread:opacity-100 group-focus-visible/thread:opacity-100" />
    </button>
  );
}
