/**
 * The in-chat 话题 hint (docs/product-rules/bot-group-chat.md §10「话题未读与提示」): a small
 * button above the composer, at the column's right edge. Personal mentions extend this same
 * surface with original questions and stand-in answers. With no pending mentions, the original
 * single-Thread shortcut and followed-Thread list remain. Dismissal never acknowledges reads.
 */
import { useId, useState } from 'react';
import { AtSign, ArrowUpRight, ChevronRight, MessagesSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, BotGroupThreadSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import type { GroupMaskMention } from './groupMaskPresentation';

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

function MentionRow({ entry, onLocate }: { entry: GroupMaskMention; onLocate: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const replyId = useId();
  return (
    <div className="border-b border-[var(--border-default)] px-2 py-2 last:border-b-0">
      <div className="flex min-h-8 items-center gap-2 text-12">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <UnreadDot />
          <span className="break-words font-medium text-[var(--text-primary)]">{entry.authorName}</span>
          <span className="text-[var(--text-tertiary)]">{t(`bots.groupChat.mask.catchup.${entry.threadRootId ? 'thread' : 'main'}`)}</span>
        </span>
        {entry.reply && <button type="button" data-mention-reply={entry.messageId} aria-expanded={expanded} aria-controls={replyId}
          onClick={() => setExpanded(value => !value)}
          className={cn('flex min-h-8 shrink-0 items-center gap-1 rounded-lg text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)]', FOCUS)}>
          <span>{t('bots.groupChat.mask.catchup.answered')}</span>
          <ChevronRight size={12} aria-hidden className={cn('shrink-0', expanded && 'rotate-90')} />
        </button>}
      </div>
      <button type="button" data-mention-message={entry.messageId} onClick={onLocate}
        className={cn('flex min-h-8 w-full items-start gap-2 rounded-lg py-1 text-left hover:bg-[var(--surface-hover)]', FOCUS)}>
        <span className="min-w-0 flex-1 break-words text-13 leading-normal text-[var(--text-primary)]">{entry.text}</span>
        <ArrowUpRight size={13} aria-hidden className="mt-1 shrink-0 text-[var(--text-tertiary)]" />
      </button>
      {entry.reply && <div id={replyId} hidden={!expanded} className="mb-1 mt-2 space-y-1.5 border-l border-[var(--border-default)] py-1 pl-3">
        <div className="flex items-center gap-1.5 text-12 font-medium text-[var(--text-secondary)]">
          <BotAvatar bot={entry.reply.companion} size="xs" /><span>{entry.reply.companion.name}</span>
        </div>
        <p className="break-words text-13 leading-normal text-[var(--text-secondary)]">{entry.reply.text}</p>
      </div>}
    </div>
  );
}

export function BotGroupThreadHint({ threads, members, openRootId, onOpen, mentions = [], onLocateMention, onReadMentions, saving = false }: {
  threads: readonly BotGroupThreadSummary[];
  members: readonly BotGroupMemberView[];
  /** The Thread open beside the chat: already being read, so it never asks for attention. */
  openRootId: string | null;
  onOpen: (rootId: string) => void;
  mentions?: readonly GroupMaskMention[];
  onLocateMention?: (mention: GroupMaskMention) => void;
  onReadMentions?: () => void;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, number>>(new Map());
  const [dismissedMentions, setDismissedMentions] = useState<ReadonlySet<string>>(new Set());
  const hinted = botGroupHintThreads(threads, openRootId);
  const newMentions = mentions.some(entry => !dismissedMentions.has(entry.messageId));
  if ((!hinted.length && !mentions.length && !listOpen) || (!hasNews(hinted, dismissed) && !newMentions && !listOpen)) return null;
  const mentioned = hinted.some(thread => thread.unread.mentioned);
  const label = mentions.length ? `${t('bots.groupChat.mask.catchup.title')} · ${mentions.length}`
    : hinted.length === 1 ? t(key('hintOne')) : t(key('hintMany'), { count: hinted.length });
  const mentionedRoots = new Set(mentions.flatMap(entry => entry.threadRootId ? [entry.threadRootId] : []));
  const listedHints = hinted.filter(thread => !mentionedRoots.has(thread.rootId));
  const others = threads.filter(thread => !hinted.includes(thread) && !mentionedRoots.has(thread.rootId));
  const showList = mentions.length > 0 || hinted.length !== 1;
  const open = (rootId: string) => { setListOpen(false); onOpen(rootId); };
  return (
    <Popover open={listOpen} onOpenChange={setListOpen}>
      <PopoverAnchor asChild>
        <div data-thread-hint="" className="pointer-events-auto absolute bottom-2 right-2 z-10 flex max-w-[calc(100%-16px)] items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]">
          <button type="button" data-testid="group-attention-hint" data-count={mentions.length}
            aria-haspopup={showList ? 'dialog' : undefined} aria-expanded={showList ? listOpen : undefined}
            onClick={() => (showList ? setListOpen(value => !value) : open(hinted[0]!.rootId))}
            className={cn('flex min-w-0 items-center gap-2 rounded-full py-1.5 pl-3 pr-1 leading-5', FOCUS)}>
            {mentions.length ? <AtSign size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
              : <MessagesSquare size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />}
            <UnreadDot />
            <span className="truncate">{label}</span>
            {mentioned && !mentions.length ? <span className="shrink-0 font-medium"><span aria-hidden className="mr-1.5 font-normal text-[var(--text-tertiary)]">·</span>{t(key('hintMentioned'))}</span> : null}
          </button>
          <Tip text={t(key('hintDismiss'))}>
            <button type="button" aria-label={t(key('hintDismiss'))} onClick={() => { setDismissed(new Map([...dismissed, ...seen(hinted)])); setDismissedMentions(new Set(mentions.map(entry => entry.messageId))); setListOpen(false); }}
              className={cn('mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]', FOCUS)}>
              <X size={12} aria-hidden />
            </button>
          </Tip>
        </div>
      </PopoverAnchor>
      <PopoverContent side="top" align="end" sideOffset={8} aria-label={t(key('listLabel'))}
        className="max-h-[420px] w-[380px] max-w-[calc(100vw-32px)] overflow-y-auto p-1.5">
        {mentions.length > 0 && <section data-testid="group-mention-list">
          <header className="flex items-center justify-between gap-3 px-2 py-1.5">
            <h3 className="text-12 font-medium text-[var(--text-tertiary)]">{t('bots.groupChat.mask.catchup.title')}</h3>
            {onReadMentions && <button type="button" disabled={saving} onClick={onReadMentions}
              className={cn('min-h-8 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50', FOCUS)}>{t('bots.groupChat.mask.catchup.markAll')}</button>}
          </header>
          {mentions.map(entry => <MentionRow key={entry.messageId} entry={entry} onLocate={() => { setListOpen(false); onLocateMention?.(entry); }} />)}
        </section>}
        {!mentions.length && listOpen && !hinted.length && <p className="px-2 py-4 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.mask.catchup.empty')}</p>}
        {listedHints.length > 0 && <p className="px-2 pb-1 pt-1.5 text-12 font-medium text-[var(--text-tertiary)]">{t(key('listNews'))}</p>}
        {listedHints.map(thread => <ThreadRow key={thread.rootId} thread={thread} members={members} onOpen={() => open(thread.rootId)} />)}
        {others.length ? <p className="px-2 pb-1 pt-2 text-12 font-medium text-[var(--text-tertiary)]">{t(key('listOthers'))}</p> : null}
        {others.map(thread => <ThreadRow key={thread.rootId} thread={thread} members={members} onOpen={() => open(thread.rootId)} />)}
      </PopoverContent>
    </Popover>
  );
}
