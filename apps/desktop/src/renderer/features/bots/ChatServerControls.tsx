import { Plus, ChevronUp } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { useChatReactions } from './useChatReactions';
import { ReactionBadgeGlyph, ReactionGlyph } from './ChatReactionMotion';
import { ChatReactionButton, type ReactorReads } from './ChatReactionButton';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
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

let activeReactionPopover: ((open: boolean) => void) | undefined;

// The timeline and thread can mount separate controls for the same message.
function useReactionPopover() {
  const [open, setOpen] = useState(false);
  useEffect(() => () => {
    if (activeReactionPopover === setOpen) activeReactionPopover = undefined;
  }, []);
  function changeOpen(next: boolean) {
    if (next) {
      if (activeReactionPopover !== setOpen) activeReactionPopover?.(false);
      activeReactionPopover = setOpen;
    } else if (activeReactionPopover === setOpen) {
      activeReactionPopover = undefined;
    }
    setOpen(next);
  }
  return [open, changeOpen] as const;
}

function preserveNextReactionFocus(event: Event) {
  if (activeReactionPopover) event.preventDefault();
}

/** A message's reaction version: the room's reset version plus the message's own realtime changes. */
export const messageReactionRevision = (group: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>, messageId: string) =>
  `${group.reactionRevision ?? 0}:${group.reactionRevisions?.[messageId] ?? 0}`;

interface ChatMessageActionProps {
  pluginUi: PluginUiMessageCandidates;
  groupId?: string; shareScope: string; message: BotGroupMessageView; align?: 'left' | 'right';
  members?: readonly BotGroupMemberView[]; reactionRevision?: string | number;
  onQuote?: () => void;
  onReply?: () => void;
  replyCountShown?: boolean;
  copyText?: string;
  menuActions?: Parameters<typeof MessageActionBar>[0]['menuActions'];
  controls: ReturnType<typeof useChatReactions>;
}

export function ChatMessageReactions({ groupId, message, members, reactionRevision, align = 'left', controls }: Pick<ChatMessageActionProps, 'groupId' | 'message' | 'members' | 'reactionRevision' | 'align' | 'controls'>) {
  const { t } = useTranslation();
  const { owner, reactions, gesture } = controls;
  const reactorReads: ReactorReads = useMemo(() => new Map(), [groupId, message.id, owner, reactionRevision]);
  if (!reactions.length) return null;
  const stacked = reactions.length > 1;
  const renderBadges = (closeDetails?: () => void) => reactions.map(reaction => (
    <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reads={reactorReads} reaction={reaction} revision={reactionRevision} members={members}
      optimistic={!message.reactions?.includes(reaction)} compact={!stacked} disabled={!groupId}
      gesture={!stacked && gesture?.emoji === reaction.emoji ? gesture : undefined}
      onFinishGesture={controls.finishGesture} onToggle={() => {
        closeDetails?.();
        void controls.toggle(reaction.emoji);
      }} />
  ));
  const total = reactions.reduce((n, r) => n + r.count, 0);
  const label = t(key('reactionTotal'), { emoji: reactions.slice(0, 2).map(r => r.emoji).join(' '), count: total });
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-message-reactions=""
      className={cn('absolute -top-2.5 z-[5] w-max', align === 'right' ? '-left-1' : '-right-1')}>
      {stacked ? <ReactionDetailsPopover label={label} align={align} renderBadges={renderBadges}>
        <button type="button" aria-label={label} className="relative flex h-[22px] items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-popover px-1.5 text-13 focus-visible:ring-2 focus-visible:ring-ring">
          {reactions.slice(0, 2).map(r => <ReactionBadgeGlyph key={r.emoji} emoji={r.emoji}
            gesture={gesture ?? undefined} onFinish={controls.finishGesture} />)}
          <span className="text-11 tabular-nums text-[var(--text-secondary)]">{total}</span>
        </button>
      </ReactionDetailsPopover> : renderBadges()}
    </div>
  );
}

function ReactionDetailsPopover({ children, align, label, renderBadges }: {
  children: ReactNode; align: 'left' | 'right'; label: string; renderBadges: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useReactionPopover();
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>{children}</PopoverTrigger>
    {open && <PopoverContent side="top" align={align === 'right' ? 'start' : 'end'} collisionPadding={12}
      aria-label={label} onCloseAutoFocus={preserveNextReactionFocus}
      className="flex max-h-52 w-max max-w-[min(256px,90vw)] flex-wrap gap-1 overflow-y-auto p-2">
      {renderBadges(() => setOpen(false))}
    </PopoverContent>}
  </Popover>;
}

function ReactionPicker({ controls, onChoose }: { controls: ReturnType<typeof useChatReactions>; onChoose: (emoji: string, from?: DOMRect) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  function choice(emoji: string) {
    const selected = controls.reactions.some(r => r.emoji === emoji && r.me);
    return <button key={emoji} type="button" aria-label={emoji} aria-pressed={selected}
      className={cn(iconClass, 'text-20 motion-safe:transition-transform motion-safe:hover:scale-110 motion-safe:active:scale-95 focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-[var(--surface-hover)]')}
      onClick={event => onChoose(emoji, event.currentTarget.getBoundingClientRect())}>
      <ReactionGlyph emoji={emoji} />
    </button>;
  }
  return <>
    <div className="flex items-center justify-between gap-0.5">
      {quickReactions.map(choice)}
      <Tip text={t(key('moreReactions'))}>
        <Button type="button" variant="secondary" tone="quiet" className="w-8 px-0" aria-expanded={expanded}
          aria-label={t(key('moreReactions'))} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
        </Button>
      </Tip>
    </div>
    {expanded && <Suspense fallback={<div className="chat-full-reaction-space" aria-busy="true" />}>
      <FullReactionPicker onChoose={onChoose} />
    </Suspense>}
  </>;
}

export function ChatMessageHoverActions({ groupId, shareScope, message, align = 'left', onQuote, onReply, replyCountShown, copyText, menuActions, controls, pluginUi }: ChatMessageActionProps) {
  const { t } = useTranslation();
  const [picker, setPicker] = useReactionPopover();
  return (
    <BubbleHoverToolbar marker="data-bot-group-message-actions" side={align === 'right' ? 'left' : 'right'} open={picker}>
      <MessageActionBar pluginUi={pluginUi} copyText={copyText ?? message.content} menuActions={menuActions} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
        align={align} hovered simplifiedBotConversation compact
        onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
        quoteAction={onQuote ? { onClick: onQuote, label: t(key('quoteReply')) } : undefined}
        replyAction={onReply ? { onClick: onReply, count: replyCountShown ? undefined : message.replyCount,
          label: message.replyCount ? t(key('openTopic'), { count: message.replyCount }) : t(key('startTopic')) } : undefined}
        reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: setPicker, onCloseAutoFocus: preserveNextReactionFocus,
          content: <ReactionPicker controls={controls} onChoose={(emoji, rect) => {
            setPicker(false);
            void controls.toggle(emoji, rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }} />,
        } : undefined} />
    </BubbleHoverToolbar>
  );
}
