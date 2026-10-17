import { chatErrorKey } from './chatError';
import { useRef, useState } from 'react';
import { ChatInviteDialog } from './ChatInviteDialog';
import { ChatReactionButton } from './ChatReactionButton';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MessageActionBar } from '@/components/chat/MessageActionBar';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
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

/** The reactions under a message's text; each chip toggles the current actor's reaction. */
export function ChatMessageReactions({ groupId, message, members, reactionRevision, align = 'left', onChanged }: Pick<ChatMessageActionProps, 'groupId' | 'message' | 'members' | 'reactionRevision' | 'align' | 'onChanged'>) {
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  if (!message.reactions?.length) return null;
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className={`mt-1 flex flex-wrap items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
      {message.reactions.map(reaction => (
        <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={reactionRevision} members={members}
          disabled={busy || !groupId} onToggle={() => void react(reaction.emoji, !reaction.me)} />
      ))}
    </div>
  );
}

function ChatMessageToolbar({ groupId, shareScope, message, align = 'left', onQuote, onReply, replyCountShown, copyText, menuActions, onChanged, picker, onPickerChange }: ChatMessageActionProps & {
  picker: boolean; onPickerChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  return (
    <MessageActionBar copyText={copyText ?? message.content} menuActions={menuActions} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
      align={align} hovered simplifiedBotConversation
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
 * The message toolbar (copy, share, 引用回复, 话题, reaction, time) floating at the top right of
 * its message, Slack-style. It shows while the message (`group/message`) is hovered, while
 * keyboard focus is inside, while its reaction picker is open, and always on touch screens.
 */
export function ChatMessageHoverActions(props: ChatMessageActionProps) {
  const [picker, setPicker] = useState(false);
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-bot-group-message-actions="" data-open={picker ? '' : undefined}
      className="pointer-events-none absolute -top-3.5 right-1 z-10 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-1 py-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 data-[open]:pointer-events-auto data-[open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
      <ChatMessageToolbar {...props} picker={picker} onPickerChange={setPicker} />
    </div>
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

/** Group owners and admins create or revoke invitation links from the group header. */
export function ChatInviteButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t(key('invite'));
  return <>
    <Tip text={title}><button type="button" className={iconClass} style={WINDOW_NO_DRAG_STYLE} aria-label={title} onClick={() => setOpen(true)}><UserPlus size={16} /></button></Tip>
    {open && <ChatInviteDialog groupId={groupId} onClose={() => setOpen(false)} />}
  </>;
}
