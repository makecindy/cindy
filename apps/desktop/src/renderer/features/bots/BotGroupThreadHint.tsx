/**
 * The in-chat 话题 hint (docs/product-rules/bot-group-chat.md §10「话题未读与提示」): a small
 * button above the composer, at the column's right edge, shown while a Thread that concerns the
 * reader (one they follow, or one naming them) has unread replies. With one such Thread it opens
 * it; with more it lists this group's Threads, those with news first. Dismissing it hides it until
 * something new arrives.
 */
import { useState } from 'react';
import { MessagesSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, BotGroupThreadSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

const key = (name: string) => `bots.groupChat.server.thread.${name}`;
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** A Thread concerns the reader when they follow it or someone named them in an unread reply. */
export function botGroupHintThreads(threads: readonly BotGroupThreadSummary[], openRootId: string | null) {
  return threads.filter(thread => thread.rootId !== openRootId && thread.unread.count > 0 && (thread.unread.mentioned || thread.following === true));
}

/** What the reader had already been told about when they dismissed the hint: each Thread's newest unread reply. */
const seen = (threads: readonly BotGroupThreadSummary[]) => new Map(threads.map(thread => [thread.rootId, thread.unread.latest ?? 0]));
/** Only a reply newer than what was dismissed brings the hint back; a deleted or aged-out one does not. */
const hasNews = (threads: readonly BotGroupThreadSummary[], dismissed: ReadonlyMap<string, number>) =>
  threads.some(thread => (thread.unread.latest ?? 0) > (dismissed.get(thread.rootId) ?? -1));

function UnreadDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]" />;
}

function ThreadRow({ thread, members, onOpen }: {
  thread: BotGroupThreadSummary; members: readonly BotGroupMemberView[]; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const member = thread.rootAuthorBotId ? members.find(m => m.botId === thread.rootAuthorBotId) : undefined;
  const unread = thread.unread.count > 0;
  return (
    <button type="button" onClick={onOpen} data-thread-hint-row={thread.rootId}
      className={cn('flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface-hover)]', FOCUS)}>
      <BotAvatar size="sm" bot={{ name: thread.rootAuthorName || '?', avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span title={thread.rootText || undefined} className={cn('truncate text-13', unread ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
          {thread.rootText || t(key('emptyReply'))}
        </span>
        {thread.lastReply ? (
          <span title={thread.lastReply.text || undefined} className="truncate text-12 text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{thread.lastReply.authorName}</span>: {thread.lastReply.text || t(key('emptyReply'))}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-11 text-[var(--text-tertiary)]">
        {unread ? (
          <span className="flex items-center gap-1 font-medium text-[var(--text-primary)]"><UnreadDot />{t(key('newReplies'), { count: thread.unread.count })}</span>
        ) : <span>{t('bots.groupChat.server.replyCount', { count: thread.replyCount })}</span>}
        {thread.unread.mentioned && unread ? <span className="font-medium text-[var(--text-primary)]">{t(key('mentionedYou'))}</span> : null}
      </span>
    </button>
  );
}

export function BotGroupThreadHint({ threads, members, openRootId, onOpen }: {
  threads: readonly BotGroupThreadSummary[];
  members: readonly BotGroupMemberView[];
  /** The Thread open beside the chat: already being read, so it never asks for attention. */
  openRootId: string | null;
  onOpen: (rootId: string) => void;
}) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, number>>(new Map());
  const hinted = botGroupHintThreads(threads, openRootId);
  if (!hinted.length || (!hasNews(hinted, dismissed) && !listOpen)) return null;
  const mentioned = hinted.some(thread => thread.unread.mentioned);
  const label = hinted.length === 1 ? t(key('hintOne')) : t(key('hintMany'), { count: hinted.length });
  const others = threads.filter(thread => !hinted.includes(thread));
  const open = (rootId: string) => { setListOpen(false); onOpen(rootId); };
  return (
    <Popover open={listOpen} onOpenChange={setListOpen}>
      <PopoverAnchor asChild>
        <div data-thread-hint="" className="pointer-events-auto absolute bottom-2 right-2 z-10 flex max-w-[calc(100%-16px)] items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]">
          <button type="button" aria-haspopup={hinted.length > 1 ? 'dialog' : undefined} aria-expanded={hinted.length > 1 ? listOpen : undefined}
            onClick={() => (hinted.length === 1 ? open(hinted[0]!.rootId) : setListOpen(value => !value))}
            className={cn('flex min-w-0 items-center gap-2 rounded-full py-1.5 pl-3 pr-1 leading-5', FOCUS)}>
            <MessagesSquare size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
            <UnreadDot />
            <span className="truncate">{label}</span>
            {mentioned ? <span className="shrink-0 font-medium"><span aria-hidden className="mr-1.5 font-normal text-[var(--text-tertiary)]">·</span>{t(key('hintMentioned'))}</span> : null}
          </button>
          <Tip text={t(key('hintDismiss'))}>
            <button type="button" aria-label={t(key('hintDismiss'))} onClick={() => { setDismissed(new Map([...dismissed, ...seen(hinted)])); setListOpen(false); }}
              className={cn('mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]', FOCUS)}>
              <X size={12} aria-hidden />
            </button>
          </Tip>
        </div>
      </PopoverAnchor>
      <PopoverContent side="top" align="end" sideOffset={8} aria-label={t(key('listLabel'))}
        className="max-h-[420px] w-[380px] max-w-[calc(100vw-32px)] overflow-y-auto p-1.5">
        <p className="px-2 pb-1 pt-1.5 text-12 font-medium text-[var(--text-tertiary)]">{t(key('listNews'))}</p>
        {hinted.map(thread => <ThreadRow key={thread.rootId} thread={thread} members={members} onOpen={() => open(thread.rootId)} />)}
        {others.length ? <p className="px-2 pb-1 pt-2 text-12 font-medium text-[var(--text-tertiary)]">{t(key('listOthers'))}</p> : null}
        {others.map(thread => <ThreadRow key={thread.rootId} thread={thread} members={members} onOpen={() => open(thread.rootId)} />)}
      </PopoverContent>
    </Popover>
  );
}
