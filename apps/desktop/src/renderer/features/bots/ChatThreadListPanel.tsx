/**
 * Quiet in-group 话题 index panel (Desktop): lives inside the shared right-side ThreadPanel
 * slot so the main timeline stays unobstructed and list ↔ thread transitions happen in place.
 * Decouples findability (participated / @mentioned / followed) from notifications (follow).
 */
import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bell, BellRing, MessagesSquare, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  botGroupThreadActivityAt,
  filterBotGroupThreads,
  isBotGroupThreadActionable,
  type BotGroupThreadFilter,
} from '@cindy/maker-shared/botGroupPresentation';
import { Button } from '@/components/ui/button';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { formatAbsolute, useRelativeTime } from '@/hooks/useRelativeTime';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, BotGroupThreadSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { chatErrorKey } from './ChatServerControls';
import { ThreadPanel } from './ThreadPanel';
import type { ThreadPanelResize } from './useThreadPanelResize';

const key = (name: string) => `bots.groupChat.server.thread.${name}`;
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function memberFor(members: readonly BotGroupMemberView[], botId: string | null) {
  return botId ? members.find(member => member.botId === botId) : undefined;
}

function ThreadIndexRow({
  thread,
  members,
  filter,
  togglingFollow,
  onOpen,
  onToggleFollow,
  onLocateRoot,
}: {
  thread: BotGroupThreadSummary;
  members: readonly BotGroupMemberView[];
  filter: BotGroupThreadFilter;
  togglingFollow: boolean;
  onOpen: () => void;
  onToggleFollow?: () => void;
  onLocateRoot?: () => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const rootMember = memberFor(members, thread.rootAuthorBotId);
  const actionable = isBotGroupThreadActionable(thread);
  const activityMs = botGroupThreadActivityAt(thread);
  const activityIso = activityMs > 0 ? new Date(activityMs).toISOString() : undefined;
  const relative = useRelativeTime(activityIso, { hovered });
  const mentionPreview = filter === 'mentions' && thread.lastMention ? thread.lastMention : null;
  const preview = mentionPreview ?? thread.lastReply;
  const responders = thread.responders ?? [];

  return (
    <div
      data-thread-index-row={thread.rootId}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="group/row relative rounded-lg transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)]"
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left',
          FOCUS,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BotAvatar
            size="xs"
            className="h-[18px] w-[18px] shrink-0 text-11"
            bot={{
              name: thread.rootAuthorName || '?',
              avatar: rootMember?.avatar ?? null,
              avatarUrl: rootMember?.avatarUrl,
              avatarColor: rootMember?.avatarColor ?? null,
            }}
          />
          <span
            title={thread.rootText || undefined}
            className={cn(
              'min-w-0 flex-1 truncate text-13 leading-[1.54] text-[var(--text-primary)]',
              actionable ? 'font-medium' : 'font-normal',
            )}
          >
            {thread.rootText || t(key('emptyReply'))}
          </span>
          {relative ? (
            <span
              title={formatAbsolute(activityIso)}
              className="shrink-0 whitespace-nowrap text-11 leading-[1.455] tabular-nums text-[var(--text-tertiary)] group-hover/row:opacity-0 group-focus-within/row:opacity-0"
            >
              {relative}
            </span>
          ) : null}
        </span>

        {preview ? (
          <span
            title={preview.text || undefined}
            className="min-w-0 truncate pl-[26px] text-12 leading-[1.334] text-[var(--text-secondary)]"
          >
            <span className="font-medium text-[var(--text-primary)]">{preview.authorName}</span>
            {': '}
            {preview.text || t(key('emptyReply'))}
          </span>
        ) : null}

        <span className="flex min-w-0 items-center gap-2 pl-[26px] text-11 leading-[1.455] text-[var(--text-tertiary)]">
          {responders.length > 0 ? (
            <span aria-hidden className="flex shrink-0 items-center -space-x-1">
              {responders.map(responder => {
                const member = memberFor(members, responder.authorBotId);
                return (
                  <BotAvatar
                    key={responder.id}
                    size="xs"
                    className="h-[15px] w-[15px] text-10 ring-1 ring-[var(--surface)]"
                    bot={{
                      name: responder.authorName,
                      avatar: member?.avatar ?? null,
                      avatarUrl: member?.avatarUrl,
                      avatarColor: member?.avatarColor ?? null,
                    }}
                  />
                );
              })}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">
            {t('bots.groupChat.server.replyCount', { count: thread.replyCount })}
          </span>
          {thread.unread.mentioned && actionable ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 font-medium leading-none text-[var(--text-primary)]">
              {t(key('mentionedYou'))}
            </span>
          ) : thread.mentionedMe ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 leading-none text-[var(--text-secondary)]">
              {t(key('indexMentionedTag'))}
            </span>
          ) : thread.participated ? (
            <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
              <span aria-hidden className="mr-1.5">·</span>
              {t(key('indexParticipatedTag'))}
            </span>
          ) : null}
          {thread.following ? (
            <BellRing size={11} aria-label={t(key('following'))} className="shrink-0 text-[var(--text-tertiary)]" />
          ) : null}
          {actionable ? (
            <span
              data-thread-index-unread={thread.unread.count}
              className="ml-auto flex shrink-0 items-center gap-1 font-medium text-[var(--text-primary)]"
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]" />
              <span>{t(key('newReplies'), { count: thread.unread.count })}</span>
            </span>
          ) : null}
        </span>
      </button>

      {(onToggleFollow || onLocateRoot) ? (
        <div className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100">
          {onToggleFollow && thread.following !== undefined ? (
            <Tip text={t(key(thread.following ? 'unfollowTip' : 'followTip'))}>
              <button
                type="button"
                disabled={togglingFollow}
                aria-pressed={thread.following}
                aria-label={t(key(thread.following ? 'following' : 'follow'))}
                onClick={event => { event.stopPropagation(); onToggleFollow(); }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] disabled:opacity-50',
                  FOCUS,
                )}
              >
                {thread.following ? <BellRing size={12} aria-hidden /> : <Bell size={12} aria-hidden />}
              </button>
            </Tip>
          ) : null}
          {onLocateRoot ? (
            <Tip text={t(key('locateInGroup'))}>
              <button
                type="button"
                aria-label={t(key('locateInGroup'))}
                onClick={event => { event.stopPropagation(); onLocateRoot(); }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
                  FOCUS,
                )}
              >
                <ArrowUpRight size={13} aria-hidden />
              </button>
            </Tip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ChatThreadListPanel({
  groupId,
  threads,
  members,
  filter,
  onFilterChange,
  onOpenThread,
  onLocateRoot,
  onRefresh,
  onClose,
  resize,
}: {
  groupId: string;
  threads: readonly BotGroupThreadSummary[];
  members: readonly BotGroupMemberView[];
  filter: BotGroupThreadFilter;
  onFilterChange: (filter: BotGroupThreadFilter) => void;
  onOpenThread: (rootId: string, focusMessageId?: string) => void;
  onLocateRoot?: (rootId: string) => void;
  onRefresh?: () => void;
  onClose: () => void;
  resize?: ThreadPanelResize;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const options = useMemo<readonly SegmentedOption<BotGroupThreadFilter>[]>(() => [
    { value: 'mine', label: t(key('filterMine')) },
    { value: 'mentions', label: t(key('filterMentions')) },
    { value: 'all', label: t(key('filterAll')) },
  ], [t]);

  const { unread, recent } = useMemo(
    () => filterBotGroupThreads(threads, filter, query),
    [threads, filter, query],
  );
  const totalShown = unread.length + recent.length;

  const toggleFollow = async (thread: BotGroupThreadSummary) => {
    if (thread.following === undefined || togglingIds.has(thread.rootId)) return;
    const api = window.electronAPI?.maker?.chatServer;
    if (!api?.followThread) return;
    setTogglingIds(previous => new Set([...previous, thread.rootId]));
    try {
      const result = await api.followThread({ groupId, rootId: thread.rootId, following: !thread.following });
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else onRefresh?.();
    } catch {
      toast.error(t('bots.groupChat.server.requestFailed'));
    } finally {
      setTogglingIds(previous => {
        const next = new Set(previous);
        next.delete(thread.rootId);
        return next;
      });
    }
  };

  const openThread = (thread: BotGroupThreadSummary) => {
    const focusId = filter === 'mentions' ? thread.lastMention?.messageId : undefined;
    onOpenThread(thread.rootId, focusId);
  };

  const emptyKey = query.trim()
    ? 'indexEmptySearch'
    : filter === 'mine'
      ? 'indexEmptyMine'
      : filter === 'mentions'
        ? 'indexEmptyMentions'
        : 'indexEmptyAll';

  return (
    <ThreadPanel
      inlineActions={false}
      title={t(key('indexTitle'))}
      resize={resize}
      onClose={onClose}
    >
      <div
        data-testid="bot-group-thread-list-panel"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 flex-col gap-2.5 border-b border-[var(--border-default)] px-4 pb-3 pt-3">
          <SegmentedControl
            role="tablist"
            fullWidth
            value={filter}
            options={options}
            onValueChange={onFilterChange}
            aria-label={t(key('filterAria'))}
          />
          <div className="relative flex items-center">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 text-[var(--text-tertiary)]"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t(key('searchPlaceholder'))}
              aria-label={t(key('searchPlaceholder'))}
              data-testid="bot-group-thread-search"
              className={cn(
                'h-8 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] pl-8 pr-7 text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                FOCUS,
              )}
            />
            {query ? (
              <button
                type="button"
                aria-label={t(key('clearSearch'))}
                onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
                className={cn(
                  'absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                  FOCUS,
                )}
              >
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {totalShown === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <MessagesSquare size={22} aria-hidden className="text-[var(--text-tertiary)]" />
              <p className="mt-2.5 text-13 text-[var(--text-secondary)]">
                {t(key(emptyKey))}
              </p>
              {!query.trim() && filter !== 'all' && threads.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  className="mt-3"
                  onClick={() => onFilterChange('all')}
                >
                  {t(key('viewAllThreads'))}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {unread.length > 0 ? (
                <>
                  <p className="px-2.5 pb-1 pt-1 text-12 font-medium text-[var(--text-tertiary)]">
                    {t(key('listNews'))}
                  </p>
                  {unread.map(thread => (
                    <ThreadIndexRow
                      key={thread.rootId}
                      thread={thread}
                      members={members}
                      filter={filter}
                      togglingFollow={togglingIds.has(thread.rootId)}
                      onOpen={() => openThread(thread)}
                      onToggleFollow={thread.following !== undefined ? () => void toggleFollow(thread) : undefined}
                      onLocateRoot={onLocateRoot ? () => onLocateRoot(thread.rootId) : undefined}
                    />
                  ))}
                </>
              ) : null}
              {recent.length > 0 ? (
                <>
                  {unread.length > 0 ? (
                    <p className="px-2.5 pb-1 pt-2.5 text-12 font-medium text-[var(--text-tertiary)]">
                      {t(key('listRecent'))}
                    </p>
                  ) : null}
                  {recent.map(thread => (
                    <ThreadIndexRow
                      key={thread.rootId}
                      thread={thread}
                      members={members}
                      filter={filter}
                      togglingFollow={togglingIds.has(thread.rootId)}
                      onOpen={() => openThread(thread)}
                      onToggleFollow={thread.following !== undefined ? () => void toggleFollow(thread) : undefined}
                      onLocateRoot={onLocateRoot ? () => onLocateRoot(thread.rootId) : undefined}
                    />
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </ThreadPanel>
  );
}
