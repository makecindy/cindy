import { chatErrorKey } from './chatError';
import { useRef, useState } from 'react';
import { ChatReactionButton } from './ChatReactionButton';
import { useTranslation } from 'react-i18next';
import { BubbleHoverToolbar, MessageActionBar } from '@/components/chat/MessageActionBar';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupDetail, BotGroupMemberView, BotGroupMessageView } from '../../../shared/botGroupChat';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
const emojiChoices = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';
export { chatErrorKey } from './chatError';

/** A message's reaction version: the room's reset version plus the message's own realtime changes. */
export const messageReactionRevision = (group: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>, messageId: string) =>
  `${group.reactionRevision ?? 0}:${group.reactionRevisions?.[messageId] ?? 0}`;

/** Adds or removes the current actor's reaction; the caller re-reads the authoritative message. */
function useChatReaction(groupId: string | undefined, messageId: string, onChanged: (messageId: string) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function react(emoji: string, present: boolean) {
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api().react({ groupId, messageId, emoji, present });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else onChanged(messageId);
    } catch { if (isDataOwnerGenerationCurrent(owner)) toast.error(t(key('requestFailed'))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return { busy, react };
}

interface ChatMessageActionProps {
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

/**
 * The reactions on a message; each badge toggles the current actor's reaction. `corner` hangs them over
 * the bubble's outer top corner (right for others, left for your own) so they never take a row. They stay
 * in flow so the bubble widens to fit them, and wrap when even the widest bubble cannot.
 */
export function ChatMessageReactions({ groupId, message, members, reactionRevision, align = 'left', corner = false, onChanged }: Pick<ChatMessageActionProps, 'groupId' | 'message' | 'members' | 'reactionRevision' | 'align' | 'onChanged'> & { corner?: boolean }) {
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  if (!message.reactions?.length) return null;
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-reaction-corner={corner ? align : undefined}
      className={cn('flex items-center gap-1',
        corner ? cn('relative z-[5] -mb-2 max-w-[calc(100%+10px)] flex-wrap', align === 'right' ? 'self-start -ml-2.5 flex-row-reverse' : 'self-end -mr-2.5 justify-end')
          : cn('mt-1 flex-wrap', align === 'right' && 'justify-end'))}>
      {message.reactions.map(reaction => (
        <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={reactionRevision} members={members}
          corner={corner} disabled={busy || !groupId} onToggle={() => void react(reaction.emoji, !reaction.me)} />
      ))}
    </div>
  );
}

function ChatMessageToolbar({ groupId, shareScope, message, align = 'left', onQuote, onReply, replyCountShown, copyText, menuActions, onChanged, picker, onPickerChange, compact = false }: ChatMessageActionProps & {
  picker: boolean; onPickerChange: (open: boolean) => void; compact?: boolean;
}) {
  const { t } = useTranslation();
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  return (
    <MessageActionBar copyText={copyText ?? message.content} menuActions={menuActions} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
      align={align} hovered simplifiedBotConversation compact={compact}
      onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
      quoteAction={onQuote ? { onClick: onQuote, label: t(key('quoteReply')) } : undefined}
      replyAction={onReply ? { onClick: onReply, count: replyCountShown ? undefined : message.replyCount,
        label: message.replyCount ? t(key('openTopic'), { count: message.replyCount }) : t(key('startTopic')) } : undefined}
      reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: onPickerChange, disabled: busy,
        content: <div className="grid grid-cols-6 gap-1">{emojiChoices.map(emoji =>
          <button type="button" key={emoji} className={iconClass} aria-label={emoji}
            onClick={() => { onPickerChange(false); void react(emoji, !message.reactions?.some(r => r.emoji === emoji && r.me)); }}>{emoji}</button>)}</div>,
      } : undefined} />
  );
}

/**
 * The compact toolbar (引用回复, 话题, reaction, more) beside its message bubble: on the outer side of the
 * bubble (right of others, left of your own), level with its top, inside the message row so moving
 * the pointer across the gap keeps the row hovered. With reactions on the bubble's corner it steps
 * past them. It shows while the message (`group/message`) is hovered, while keyboard focus is
 * inside, while its reaction picker is open, and always on touch screens. Copy, share and the exact
 * time are in its more menu.
 */
export function ChatMessageHoverActions({ besideReactions = false, ...props }: ChatMessageActionProps & { besideReactions?: boolean }) {
  const [picker, setPicker] = useState(false);
  return (
    <BubbleHoverToolbar marker="data-bot-group-message-actions" side={props.align === 'right' ? 'left' : 'right'}
      open={picker} besideReactions={besideReactions}>
      <ChatMessageToolbar {...props} compact picker={picker} onPickerChange={setPicker} />
    </BubbleHoverToolbar>
  );
}

/** Reactions and the toolbar stacked under the text, always visible. */
export function ChatMessageActions(props: ChatMessageActionProps) {
  const [picker, setPicker] = useState(false);
  const align = props.align ?? (props.message.isSelf ? 'right' : 'left');
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className="mt-1 flex flex-col gap-1">
      <ChatMessageReactions {...props} align={align} />
      <ChatMessageToolbar {...props} align={align} picker={picker} onPickerChange={setPicker} />
    </div>
  );
}
