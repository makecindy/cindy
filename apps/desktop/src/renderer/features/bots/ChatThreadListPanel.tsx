/**
 * Quiet in-group 话题 index panel (Desktop): lives inside the shared right-side ThreadPanel
 * slot so the main timeline stays unobstructed and list ↔ thread transitions happen in place.
 * Decouples findability (participated / @mentioned / followed) from notifications (follow).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bell, BellRing, CircleDot, GitPullRequest, MessagesSquare, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { prStatusKey, prStatusQuery, type PrIdentity } from '@cindy/maker-shared';
import {
  botGroupCodeRefLabel,
  botGroupThreadActivityAt,
  filterBotGroupThreads,
  formatBotGroupThreadRootTitle,
  isBotGroupThreadActionable,
  pickBotGroupThreadDisplayRefs,
  type BotGroupThreadFilter,
} from '@cindy/maker-shared/botGroupPresentation';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { Button } from '@/components/ui/button';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { useRelativeTime, formatAbsolute } from '@/hooks/useRelativeTime';
import type { PrStatusResult } from '@/lib/gitContext.types';
import { MAX_STATUS_BATCH, MAX_TASK_STATUS_QUERIES } from '@/lib/prStatus';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, BotGroupThreadCodeRef, BotGroupThreadSummary } from '../../../shared/botGroupChat';
import {
  PR_STATUS_ICON,
  prStatusIconColor,
  shouldShowPrUnresolvedDot,
} from '../cc-agent/gitContextPrVisuals';
import { BotAvatar } from './BotAvatar';
import { chatErrorKey } from './ChatServerControls';
import { ThreadPanel } from './ThreadPanel';
import type { ThreadPanelResize } from './useThreadPanelResize';

const key = (name: string) => `bots.groupChat.server.thread.${name}`;
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function toPrIdentity(ref: BotGroupThreadCodeRef): PrIdentity {
  return {
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.number,
    ...(ref.provider === 'gitlab' ? { provider: ref.provider, host: ref.host } : {}),
  };
}

function memberFor(members: readonly BotGroupMemberView[], botId: string | null) {
  return botId ? members.find(member => member.botId === botId) : undefined;
}

function ThreadCodeRefChip({
  codeRef,
  prStatus,
  isDark,
}: {
  codeRef: BotGroupThreadCodeRef;
  prStatus?: PrStatusResult;
  isDark: boolean;
}) {
  const { t } = useTranslation();
  const label = botGroupCodeRefLabel(codeRef);
  const isPr = codeRef.kind === 'pr';
  const kind = isPr && prStatus?.ok ? prStatus.status : null;
  const unresolvedCount = isPr && prStatus?.ok ? prStatus.unresolvedCount : null;
  const showDot = isPr && shouldShowPrUnresolvedDot(kind, unresolvedCount);
  const Icon = isPr ? (kind ? PR_STATUS_ICON[kind] : GitPullRequest) : CircleDot;
  const iconColor = isPr
    ? prStatusIconColor(kind, isDark ? 'dark' : 'light', prStatus?.ok ? prStatus.conflicts : null)
    : undefined;
  const repoLabel = `${codeRef.owner}/${codeRef.repo}${label}`;
  const statusSuffix = kind ? ` · ${t(`ccAgent.gitContext.pr.status.${kind}`)}` : '';
  const titleSuffix = isPr && prStatus?.ok && prStatus.title ? ` · ${prStatus.title}` : '';
  const unresolvedSuffix = showDot && unresolvedCount
    ? ` · ${t('ccAgent.gitContext.pr.unresolved', { count: unresolvedCount })}`
    : '';
  const tip = `${repoLabel}${statusSuffix}${titleSuffix}${unresolvedSuffix}`;

  return (
    <Tip text={tip}>
      <button
        type="button"
        data-thread-ref-kind={codeRef.kind}
        data-thread-ref-number={codeRef.number}
        aria-label={tip}
        onClick={event => {
          event.stopPropagation();
          void window.electronAPI?.openExternal?.(codeRef.url);
        }}
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 rounded px-1 -mx-1 py-0.5 font-mono text-11 leading-[1.455] tabular-nums text-[var(--text-tertiary)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
          FOCUS,
        )}
      >
        <span className="relative shrink-0">
          <Icon
            size={11}
            strokeWidth={1.75}
            aria-hidden
            className="block"
            style={iconColor ? { color: iconColor } : undefined}
          />
          {showDot ? (
            <span
              aria-hidden
              className="absolute -right-[1.5px] -top-[1.5px] size-[5px] rounded-full bg-[var(--status-bar-accent)] shadow-[0_0_0_1.25px_var(--surface)]"
            />
          ) : null}
        </span>
        <span>{label}</span>
      </button>
    </Tip>
  );
}

function ThreadIndexRow({
  thread,
  members,
  prStatuses,
  isDark,
  togglingFollow,
  onOpen,
  onToggleFollow,
  onLocateRoot,
}: {
  thread: BotGroupThreadSummary;
  members: readonly BotGroupMemberView[];
  prStatuses: ReadonlyMap<string, PrStatusResult>;
  isDark: boolean;
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
  const { issue, pr } = pickBotGroupThreadDisplayRefs(thread.refs);
  const prStatus = pr ? prStatuses.get(prStatusKey(toPrIdentity(pr))) : undefined;
  const rootTitle = formatBotGroupThreadRootTitle(thread, {
    kinds: {
      task: t(key('rootKind.task')),
      image: t(key('rootKind.image')),
      video: t(key('rootKind.video')),
      audio: t(key('rootKind.audio')),
      file: t(key('rootKind.file')),
      share: t(key('rootKind.share')),
      card: t(key('rootKind.card')),
    },
    empty: t(key('emptyReply')),
  });

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
          'flex w-full min-w-0 flex-col rounded-t-lg px-2.5 pb-1 pt-2 text-left',
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
            title={rootTitle}
            className={cn(
              'min-w-0 flex-1 truncate text-13 leading-[1.54] text-[var(--text-primary)]',
              actionable ? 'font-medium' : 'font-normal',
            )}
          >
            {rootTitle}
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
      </button>

      <div
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 pb-2 pl-[36px] pr-2.5 text-11 leading-[1.455] text-[var(--text-tertiary)]"
      >
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
        {(issue || pr || actionable) ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {issue ? <ThreadCodeRefChip codeRef={issue} isDark={isDark} /> : null}
            {pr ? <ThreadCodeRefChip codeRef={pr} prStatus={prStatus} isDark={isDark} /> : null}
            {actionable ? (
              <span
                data-thread-index-unread={thread.unread.count}
                className="flex shrink-0 items-center gap-1 font-medium text-[var(--text-primary)]"
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]" />
                <span>{t(key('newReplies'), { count: thread.unread.count })}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

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
  syncing = false,
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
  syncing?: boolean;
  onOpenThread: (rootId: string, focusMessageId?: string) => void;
  onLocateRoot?: (rootId: string) => void;
  onRefresh?: () => void;
  onClose: () => void;
  resize?: ThreadPanelResize;
}) {
  const { t } = useTranslation();
  const isDark = useIsDarkMode();
  const [query, setQuery] = useState('');
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(new Set());
  const [prStatuses, setPrStatuses] = useState<ReadonlyMap<string, PrStatusResult>>(() => new Map());
  const fetchedPrKeysRef = useRef<Set<string>>(new Set());
  const inFlightPrKeysRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const options = useMemo<readonly SegmentedOption<BotGroupThreadFilter>[]>(() => [
    { value: 'mine', label: t(key('filterMine')) },
    { value: 'all', label: t(key('filterAll')) },
  ], [t]);

  const { unread, recent } = useMemo(
    () => filterBotGroupThreads(threads, filter, query),
    [threads, filter, query],
  );
  const totalShown = unread.length + recent.length;

  const visiblePrs = useMemo(() => {
    const map = new Map<string, PrIdentity>();
    for (const thread of [...unread, ...recent]) {
      const { pr } = pickBotGroupThreadDisplayRefs(thread.refs);
      if (!pr) continue;
      const identity = toPrIdentity(pr);
      const statusKey = prStatusKey(identity);
      if (!map.has(statusKey)) map.set(statusKey, identity);
      if (map.size >= MAX_TASK_STATUS_QUERIES) break;
    }
    return map;
  }, [unread, recent]);
  const visiblePrsRef = useRef(visiblePrs);
  visiblePrsRef.current = visiblePrs;
  const visiblePrKey = useMemo(() => [...visiblePrs.keys()].join(','), [visiblePrs]);

  useEffect(() => {
    const getPrStatuses = window.electronAPI?.gitContext?.getPrStatuses;
    const currentPrs = visiblePrsRef.current;
    if (!getPrStatuses || currentPrs.size === 0) return;
    const pending: Array<{ key: string; identity: PrIdentity }> = [];
    for (const [statusKey, identity] of currentPrs) {
      if (fetchedPrKeysRef.current.has(statusKey) || inFlightPrKeysRef.current.has(statusKey)) continue;
      inFlightPrKeysRef.current.add(statusKey);
      pending.push({ key: statusKey, identity });
    }
    if (pending.length === 0) return;
    void (async () => {
      for (let i = 0; i < pending.length; i += MAX_STATUS_BATCH) {
        if (!mountedRef.current) return;
        const batch = pending.slice(i, i + MAX_STATUS_BATCH);
        try {
          const raw = await getPrStatuses(batch.map(item => prStatusQuery(item.identity)));
          if (!mountedRef.current) return;
          if (Array.isArray(raw)) {
            const results = raw as PrStatusResult[];
            for (const item of batch) fetchedPrKeysRef.current.add(item.key);
            setPrStatuses(prev => {
              const next = new Map(prev);
              for (const result of results) {
                if (!result || typeof result !== 'object') continue;
                next.set(prStatusKey(result), result);
              }
              return next;
            });
          }
        } catch {
          // Best-effort status coloring; chips remain readable with neutral icon + PR number.
        } finally {
          for (const item of batch) inFlightPrKeysRef.current.delete(item.key);
        }
      }
    })();
  }, [visiblePrKey]);

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
    const focusId = filter === 'mine' && (thread.unread.mentioned || thread.mentionedMe)
      ? thread.lastMention?.messageId
      : undefined;
    onOpenThread(thread.rootId, focusId);
  };

  const emptyKey = query.trim()
    ? 'indexEmptySearch'
    : filter === 'mine'
      ? 'indexEmptyMine'
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
          {totalShown === 0 && syncing ? (
            <div data-testid="bot-group-thread-syncing" className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <Spinner size={18} className="text-[var(--text-tertiary)]" />
              <p className="mt-2.5 text-13 text-[var(--text-secondary)]">
                {t(key('syncingHistory'))}
              </p>
            </div>
          ) : totalShown === 0 ? (
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
                      prStatuses={prStatuses}
                      isDark={isDark}
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
                      prStatuses={prStatuses}
                      isDark={isDark}
                      togglingFollow={togglingIds.has(thread.rootId)}
                      onOpen={() => openThread(thread)}
                      onToggleFollow={thread.following !== undefined ? () => void toggleFollow(thread) : undefined}
                      onLocateRoot={onLocateRoot ? () => onLocateRoot(thread.rootId) : undefined}
                    />
                  ))}
                </>
              ) : null}
              {syncing ? (
                <div data-testid="bot-group-thread-syncing" className="flex items-center justify-center gap-1.5 px-3 py-3 text-12 text-[var(--text-tertiary)]">
                  <Spinner size={12} />
                  <span>{t(key('syncingHistory'))}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </ThreadPanel>
  );
}
