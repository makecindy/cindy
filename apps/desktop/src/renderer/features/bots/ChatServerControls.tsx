import { ChevronDown } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { type ChatReactionReads, useChatReactions } from './useChatReactions';
import { ReactionGlyph } from './ChatReactionMotion';
import { ChatReactionButton } from './ChatReactionButton';
import { useTranslation } from 'react-i18next';
import { BubbleHoverToolbar, MessageActionBar } from '@/components/chat/MessageActionBar';
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
  if (!controls.reactions.length) return null;
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-message-reactions=""
      className={cn('flex max-w-full flex-wrap items-center gap-1', !compact && 'mt-1', align === 'right' && 'justify-end')}>
      {controls.reactions.map(reaction => (
        <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={reactionRevision} members={members}
          optimistic={!message.reactions?.includes(reaction)} compact={compact} disabled={!groupId} gesture={controls.gesture?.emoji === reaction.emoji ? controls.gesture : undefined}
          onFinishGesture={controls.finishGesture} onToggle={() => void controls.toggle(reaction.emoji)} />
      ))}
    </div>
  );
}

function ReactionPicker({ controls, onChoose }: { controls: ReturnType<typeof useChatReactions>; onChoose: (emoji: string, from?: DOMRect) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  function choice(emoji: string) {
    const selected = controls.reactions.some(r => r.emoji === emoji && r.me);
    return <button key={emoji} type="button" aria-label={emoji} aria-pressed={selected}
      className={cn(iconClass, 'text-18 motion-safe:transition-transform motion-safe:hover:scale-110 motion-safe:active:scale-95 focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--text-tertiary)]')}
      onClick={event => onChoose(emoji, event.currentTarget.getBoundingClientRect())}>
      <ReactionGlyph emoji={emoji} />
    </button>;
  }
  return <>
    <div className="flex items-center gap-1">
      {quickReactions.map(choice)}
      <button type="button" className={iconClass} aria-expanded={expanded} aria-label={t(key('moreReactions'))}
        onClick={() => setExpanded(!expanded)}>
        <ChevronDown aria-hidden className={cn('size-4 motion-safe:transition-transform', expanded && 'rotate-180')} />
      </button>
    </div>
    {expanded && <Suspense fallback={<div className="h-36" aria-busy="true" />}>
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
