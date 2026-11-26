/**
 * The in-chat attention hint (docs/product-rules/bot-group-chat.md §10「话题未读与提示」): a small
 * pill above the composer at the column's right edge. Its popover shows only personal @mentions;
 * all in-group Thread browsing lives in the dedicated header 话题 button and right-side ThreadPanel.
 * With no pending mentions, clicking jumps straight to the single unread Thread or opens the
 * right-side 话题 index. Dismissal never acknowledges reads.
 */
import { useEffect, useId, useState } from 'react';
import { AtSign, ArrowUpRight, ChevronRight, MessagesSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BotGroupThreadSummary } from '../../../shared/botGroupChat';
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

export function BotGroupThreadHint({ threads, openRootId, onOpen, onOpenList, mentions = [], onLocateMention, onReadMentions, saving = false, suppressed = false }: {
  threads: readonly BotGroupThreadSummary[];
  /** The Thread open beside the chat: already being read, so it never asks for attention. */
  openRootId: string | null;
  onOpen: (rootId: string, focusMessageId?: string) => void;
  /** Opens the persistent right-side 话题 index when multiple threads have updates. */
  onOpenList?: (filter?: 'mine' | 'all') => void;
  mentions?: readonly GroupMaskMention[];
  onLocateMention?: (mention: GroupMaskMention) => void;
  onReadMentions?: () => void;
  saving?: boolean;
  suppressed?: boolean;
}) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => { if (suppressed) setListOpen(false); }, [suppressed]);
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, number>>(new Map());
  const [dismissedMentions, setDismissedMentions] = useState<ReadonlySet<string>>(new Set());
  const hinted = botGroupHintThreads(threads, openRootId);
  const newMentions = mentions.some(entry => !dismissedMentions.has(entry.messageId));
  if ((!hinted.length && !mentions.length && !listOpen) || (!hasNews(hinted, dismissed) && !newMentions && !listOpen)) return null;
  const mentioned = hinted.some(thread => thread.unread.mentioned);
  const label = mentions.length ? `${t('bots.groupChat.mask.catchup.title')} · ${mentions.length}`
    : hinted.length === 1 ? t(key('hintOne')) : t(key('hintMany'), { count: hinted.length });
  const usePopover = mentions.length > 0 || listOpen;
  const open = (rootId: string, focusMessageId?: string) => {
    setListOpen(false);
    if (focusMessageId) onOpen(rootId, focusMessageId);
    else onOpen(rootId);
  };
  const handlePrimaryClick = () => {
    if (usePopover) { setListOpen(value => !value); return; }
    if (hinted.length === 1) {
      const single = hinted[0]!;
      open(single.rootId, single.unread.mentioned ? single.lastMention?.messageId : undefined);
      return;
    }
    if (onOpenList) {
      onOpenList('mine');
      return;
    }
    if (hinted[0]) {
      const first = hinted[0];
      open(first.rootId, first.unread.mentioned ? first.lastMention?.messageId : undefined);
    }
  };
  return (
    <Popover open={usePopover && listOpen && !suppressed} onOpenChange={setListOpen}>
      <PopoverAnchor asChild>
        <div data-thread-hint="" className="pointer-events-auto absolute bottom-2 right-2 z-raised flex max-w-[calc(100%-16px)] items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]">
          <button type="button" data-testid="group-attention-hint" data-count={mentions.length}
            aria-haspopup={usePopover ? 'dialog' : undefined} aria-expanded={usePopover ? listOpen : undefined}
            onClick={handlePrimaryClick}
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
      <PopoverContent side="top" align="end" sideOffset={8} aria-label={t('bots.groupChat.mask.catchup.title')}
        className="max-h-[420px] w-[380px] max-w-[calc(100vw-32px)] overflow-y-auto p-1.5">
        {mentions.length > 0 ? <section data-testid="group-mention-list">
          <header className="flex items-center justify-between gap-3 px-2 py-1.5">
            <h3 className="text-12 font-medium text-[var(--text-tertiary)]">{t('bots.groupChat.mask.catchup.title')}</h3>
            {onReadMentions && <button type="button" disabled={saving} onClick={onReadMentions}
              className={cn('min-h-8 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50', FOCUS)}>{t('bots.groupChat.mask.catchup.markAll')}</button>}
          </header>
          {mentions.map(entry => <MentionRow key={entry.messageId} entry={entry} onLocate={() => { setListOpen(false); onLocateMention?.(entry); }} />)}
        </section> : (
          <p className="px-2 py-4 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.mask.catchup.empty')}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
