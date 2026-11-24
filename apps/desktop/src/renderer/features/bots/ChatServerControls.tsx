import { Plus, ChevronUp } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { type ChatReactionReads, useChatReactions } from './useChatReactions';
import { ChatReactionMotion, ReactionGlyph } from './ChatReactionMotion';
import { ChatReactionButton } from './ChatReactionButton';
import { useTranslation } from 'react-i18next';
import { BubbleHoverToolbar, MessageActionBar } from '@/components/chat/MessageActionBar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';
import type { PluginUiMessageCandidates } from '@/cindy-brain/PluginUiContributions';
import type { BotGroupDetail, BotGroupMemberView, BotGroupMessageView } from '../../../shared/botGroupChat';

const key = (name: string) => `bots.groupChat.server.${name}`;
const quickReactions = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];
const FullReactionPicker = lazy(() => import('./FullReactionPicker'));
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';
export { chatErrorKey } from './chatError';

/** A message's reaction version: the room's reset version plus the message's own realtime changes. */
export const messageReactionRevision = (group: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>, messageId: string) =>
  `${group.reactionRevision ?? 0}:${group.reactionRevisions?.[messageId] ?? 0}`;

interface ChatMessageActionProps {
  reactionReads?: ChatReactionReads;
  pluginUi: PluginUiMessageCandidates;
  groupId?: string; shareScope: string; message: BotGroupMessageView; align?: 'left' | 'right';
  /** Who can be named on a reaction badge, and the message's reaction version (see `messageReactionRevision`). */
  members?: readonly BotGroupMemberView[]; reactionRevision?: string | number;
  /** 引用回复: a new main-timeline message that quotes this one. */
  onQuote?: () => void;
  /** Opens the message's Thread (话题) — 创建话题 before anyone answered, 查看话题 after. */
  onReply?: () => void;
  replyCountShown?: boolean;
  copyText?: string;
  menuActions?: Parameters<typeof MessageActionBar>[0]['menuActions'];
  /** The current actor's reaction on `messageId` changed: re-read that message's copy. */
  onChanged: (messageId: string) => void;
}

export function ChatMessageReactions({ groupId, message, members, reactionRevision, align = 'left', compact = false, controls }: Pick<ChatMessageActionProps, 'groupId' | 'message' | 'members' | 'reactionRevision' | 'align'> & { compact?: boolean; controls: ReturnType<typeof useChatReactions> }) {
  const { t } = useTranslation();
  const { reactions, gesture } = controls;
  if (!reactions.length) return null;
  const stacked = compact && reactions.length > 1;
  const badges = reactions.map(reaction => (
    <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={reactionRevision} members={members}
      optimistic={!message.reactions?.includes(reaction)} compact={compact && !stacked} disabled={!groupId}
      gesture={!stacked && gesture?.emoji === reaction.emoji ? gesture : undefined}
      onFinishGesture={controls.finishGesture} onToggle={() => void controls.toggle(reaction.emoji)} />
  ));
  const total = reactions.reduce((n, r) => n + r.count, 0);
  const label = t(key('reactionCount'), { emoji: reactions.slice(0, 2).map(r => r.emoji).join(' '), count: total });
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-message-reactions=""
      className={compact ? cn('absolute -top-2.5 z-[5] w-max', align === 'right' ? '-left-1' : '-right-1') : cn('mt-1 flex flex-wrap items-center gap-1', align === 'right' && 'justify-end')}>
      {stacked ? <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={label} className="relative flex h-[22px] items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-popover px-1.5 text-13 focus-visible:ring-2 focus-visible:ring-ring">
            {reactions.slice(0, 2).map(r => <ReactionGlyph key={r.emoji} emoji={r.emoji} />)}
            <span className="text-11 tabular-nums text-[var(--text-secondary)]">{total}</span>
            {gesture && <ChatReactionMotion key={gesture.emoji} gesture={gesture} onFinish={controls.finishGesture} />}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align={align === 'right' ? 'start' : 'end'} collisionPadding={12} aria-label={label}
          className="flex max-h-52 w-max max-w-[min(256px,90vw)] flex-wrap gap-1 overflow-y-auto p-2">{badges}</PopoverContent>
      </Popover> : badges}
    </div>
  );
}

function ReactionPicker({ controls, onChoose }: { controls: ReturnType<typeof useChatReactions>; onChoose: (emoji: string, from?: DOMRect) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  function choice(emoji: string) {
    const selected = controls.reactions.some(r => r.emoji === emoji && r.me);
    return <button key={emoji} type="button" aria-label={emoji} aria-pressed={selected}
      className={cn(iconClass, 'text-20 motion-safe:transition-transform motion-safe:hover:scale-110 motion-safe:active:scale-95 focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--text-tertiary)]')}
      onClick={event => onChoose(emoji, event.currentTarget.getBoundingClientRect())}>
      <ReactionGlyph emoji={emoji} />
    </button>;
  }
  return <>
    <div className="flex items-center justify-between gap-0.5">
      {quickReactions.map(choice)}
      <button type="button" className={iconClass} aria-expanded={expanded} aria-label={t(key('moreReactions'))}
        onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronUp aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
      </button>
    </div>
    {expanded && <Suspense fallback={<div className="chat-full-reaction-space" aria-busy="true" />}>
      <FullReactionPicker onChoose={onChoose} />
    </Suspense>}
  </>;
}

function ChatMessageToolbar({ groupId, shareScope, message, align = 'left', onQuote, onReply, replyCountShown, copyText, menuActions, controls, picker, onPickerChange, compact = false, pluginUi }: Omit<ChatMessageActionProps, 'onChanged'> & {
  controls: ReturnType<typeof useChatReactions>;
  picker: boolean; onPickerChange: (open: boolean) => void; compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <MessageActionBar pluginUi={pluginUi} copyText={copyText ?? message.content} menuActions={menuActions} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
      align={align} hovered simplifiedBotConversation compact={compact}
      onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
      quoteAction={onQuote ? { onClick: onQuote, label: t(key('quoteReply')) } : undefined}
      replyAction={onReply ? { onClick: onReply, count: replyCountShown ? undefined : message.replyCount,
        label: message.replyCount ? t(key('openTopic'), { count: message.replyCount }) : t(key('startTopic')) } : undefined}
      reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: onPickerChange,
        content: <ReactionPicker controls={controls} onChoose={(emoji, rect) => {
          onPickerChange(false);
          void controls.toggle(emoji, rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }} />,
      } : undefined} />
  );
}

/**
 * The compact toolbar (引用回复, 话题, reaction, more) beside its message bubble: on the outer side of the
 * bubble (right of others, left of your own), level with its top, inside the message row so moving
 * the pointer across the gap keeps the row hovered. It shows while the message (`group/message`) is hovered, while keyboard focus is
 * inside, while its reaction picker is open, and always on touch screens. Copy, share and the exact
 * time are in its more menu.
 */
export function ChatMessageHoverActions(props: Omit<ChatMessageActionProps, 'onChanged'> & { controls: ReturnType<typeof useChatReactions> }) {
  const [picker, setPicker] = useState(false);
  return (
    <BubbleHoverToolbar marker="data-bot-group-message-actions" side={props.align === 'right' ? 'left' : 'right'}
      open={picker}>
      <ChatMessageToolbar {...props} compact picker={picker} onPickerChange={setPicker} />
    </BubbleHoverToolbar>
  );
}

/** Reactions and the toolbar stacked under the text, always visible. */
export function ChatMessageActions(props: ChatMessageActionProps) {
  const [picker, setPicker] = useState(false);
  const controls = useChatReactions(props.groupId, props.message, props.onChanged, props.reactionReads);
  const align = props.align ?? (props.message.isSelf ? 'right' : 'left');
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className="mt-1 flex flex-col gap-1">
      <ChatMessageReactions {...props} controls={controls} align={align} />
      <ChatMessageToolbar {...props} controls={controls} align={align} picker={picker} onPickerChange={setPicker} />
    </div>
  );
}
