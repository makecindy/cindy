import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Pencil, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_DRAFT_SESSION_TITLE, isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { cn } from '@/lib/utils';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useSessionLifecycleActions } from '@/features/cc-agent/hooks/useSessionLifecycleActions';
import { SessionRenameInput } from '@/features/cc-agent/SessionRenameInput';
import { formatSidebarTimeAbsolute } from '@/features/cc-agent/lib/formatSidebarTime';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { useRegisterContentHeader } from '../feature-context';
import { BotAvatar } from './BotAvatar';
import { BotGenerationLabel } from './BotGenerationLabel';
import { formatBotListTimestamp } from './botListDisplay';
import { refreshBotProfiles, useBotProfiles, useBotProfilesLoadState, type BotSessionProjection } from './botStore';
import { TeammateRunningPreview } from './TeammateStatusDot';

interface ConversationGroup {
  key: string;
  label: string;
  sessions: BotSessionProjection[];
}

function localDayKey(date: Date): string {
  return (
    String(date.getFullYear()) +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  );
}

function conversationActivityAt(session: BotSessionProjection): number {
  const candidates = [session.lastActivityAt, session.updatedAt, session.createdAt];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function conversationDisplayTitle(
  session: BotSessionProjection,
  botName: string,
  t: (key: string) => string,
  overrideTitle?: string,
): string {
  const rawTitle = (overrideTitle ?? session.title).trim();
  if (!rawTitle || isDefaultDraftSessionTitle(rawTitle)) {
    return t('bots.chat.untitledConversation');
  }
  if (session.role === 'canonical' && rawTitle === botName) {
    return t('bots.chat.mainConversation');
  }
  return rawTitle;
}

function groupConversations(
  sessions: readonly BotSessionProjection[],
  now: Date,
  locale: string,
  t: (key: string) => string,
): ConversationGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayOrdinal = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const groups = new Map<string, ConversationGroup>();
  const sorted = [...sessions].sort(
    (a, b) => conversationActivityAt(b) - conversationActivityAt(a) || a.id.localeCompare(b.id),
  );
  for (const session of sorted) {
    const timestamp = conversationActivityAt(session);
    const activity = new Date(timestamp);
    const day = new Date(activity.getFullYear(), activity.getMonth(), activity.getDate());
    const ageDays = Math.floor(
      (todayOrdinal - Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / 86_400_000,
    );
    const key = localDayKey(day);
    const label =
      ageDays <= 0
        ? t('ccAgent.sidebar.dateGroup.today')
        : ageDays === 1
          ? t('ccAgent.sidebar.dateGroup.yesterday')
          : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(day);
    const group = groups.get(key);
    if (group) group.sessions.push(session);
    else groups.set(key, { key, label, sessions: [session] });
  }
  return [...groups.values()];
}

export function BotConversationDirectory() {
  const { t, i18n } = useTranslation();
  const { botId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const loadState = useBotProfilesLoadState();
  const bot = profiles.find((item) => item.id === botId && item.status === 'active');
  const islandActivity = useAgentIslandActivityMap();
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [optimisticTitles, setOptimisticTitles] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const committedRenameRef = useRef(false);
  const { confirm } = useConfirmDialog();
  const { runSessionAction } = useSessionLifecycleActions();

  useEffect(() => {
    refreshBotProfiles();
    setSearchQuery('');
    setEditingId(null);
    setContextMenu(null);
  }, [botId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const conversations = useMemo(
    () =>
      (bot?.sessions ?? []).filter(
        (session) => (session.role === 'canonical' || session.role === 'chat') && session.status === 'active',
      ),
    [bot?.sessions],
  );

  useEffect(() => {
    setOptimisticTitles((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) return current;
      const byId = new Map(conversations.map((session) => [session.id, session.title]));
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, title] of entries) {
        const persisted = byId.get(id);
        if (persisted !== undefined && persisted !== title) {
          next[id] = title;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [conversations]);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredConversations = useMemo(() => {
    if (!normalizedQuery || !bot) return conversations;
    return conversations.filter((session) => {
      const title = conversationDisplayTitle(session, bot.name, t, optimisticTitles[session.id]).toLocaleLowerCase();
      const preview = (session.preview ?? '').toLocaleLowerCase();
      return title.includes(normalizedQuery) || preview.includes(normalizedQuery);
    });
  }, [bot, conversations, normalizedQuery, optimisticTitles, t]);

  const locale = i18n.resolvedLanguage || i18n.language;
  const groups = useMemo(
    () => groupConversations(filteredConversations, new Date(now), locale, t),
    [filteredConversations, now, locale, t],
  );

  const directoryPath = '/bots/' + encodeURIComponent(botId ?? '') + '/conversations';
  const openSettings = useCallback(() => {
    const search = new URLSearchParams(location.search);
    search.set('settings', '1');
    navigate(directoryPath + '?' + search.toString());
  }, [directoryPath, location.search, navigate]);

  const header = useMemo(
    () =>
      bot ? (
        <div className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
          <button
            type="button"
            onClick={() => navigate(directoryPath)}
            aria-label={t('bots.chat.directoryTitle', { name: bot.name })}
            className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            style={WINDOW_NO_DRAG_STYLE}
          >
            <BotAvatar bot={bot} size="xs" />
            <span className="truncate">{bot.name}</span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tip text={t('bots.settings')} side="bottom">
              <button
                type="button"
                onClick={openSettings}
                aria-label={t('bots.settings')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                style={WINDOW_NO_DRAG_STYLE}
              >
                <Settings2 size={15} />
              </button>
            </Tip>
          </div>
        </div>
      ) : null,
    [bot, directoryPath, navigate, openSettings, t],
  );
  useRegisterContentHeader(header);

  if (!botId) return <Navigate to="/bots" replace />;
  if (!bot && loadState !== 'ready') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner size={20} />
      </main>
    );
  }
  if (!bot) return <Navigate to={'/bots/' + encodeURIComponent(botId)} replace />;

  const openConversation = (sessionId: string) => {
    if (editingId === sessionId) return;
    navigate('/bots/' + encodeURIComponent(bot.id) + '/session/' + encodeURIComponent(sessionId));
  };

  const createConversation = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const result = (await window.electronAPI.localDb.bots.createChatSession({
        botId: bot.id,
        title: DEFAULT_DRAFT_SESSION_TITLE,
      })) as { id?: unknown };
      refreshBotProfiles();
      if (typeof result.id === 'string') {
        navigate('/bots/' + encodeURIComponent(bot.id) + '/session/' + encodeURIComponent(result.id));
      }
    } catch {
      toast.error(t('bots.chat.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const startRename = (session: BotSessionProjection) => {
    const currentDisplay = conversationDisplayTitle(session, bot.name, t, optimisticTitles[session.id]);
    const raw = (optimisticTitles[session.id] ?? session.title).trim();
    const initial =
      !raw || isDefaultDraftSessionTitle(raw) || (session.role === 'canonical' && raw === bot.name)
        ? currentDisplay
        : raw;
    setContextMenu(null);
    committedRenameRef.current = false;
    setEditValue(initial);
    setEditingId(session.id);
  };

  const cancelRename = () => {
    committedRenameRef.current = true;
    setEditingId(null);
  };

  const commitRename = async (session: BotSessionProjection, raw: string) => {
    if (committedRenameRef.current) return;
    committedRenameRef.current = true;
    setEditingId(null);
    const trimmed = raw.trim();
    const currentDisplay = conversationDisplayTitle(session, bot.name, t, optimisticTitles[session.id]);
    if (!trimmed || trimmed === currentDisplay) return;
    setOptimisticTitles((current) => ({ ...current, [session.id]: trimmed }));
    try {
      await sessionService.patchMeta(session.id, { title: trimmed });
      refreshBotProfiles();
    } catch {
      setOptimisticTitles((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      toast.error(t('ccAgent.sidebar.renameFailed'));
    }
  };

  const deleteConversation = async (session: BotSessionProjection) => {
    if (deletingId) return;
    setContextMenu(null);
    if (editingId === session.id) cancelRename();
    const accepted = await confirm({
      title: t('bots.chat.deleteTitle'),
      description: t('bots.chat.deleteDescription'),
      confirmText: t('bots.chat.deleteConfirm'),
      cancelText: t('bots.chat.cancel'),
      confirmVariant: 'destructive',
    });
    if (!accepted) return;
    setDeletingId(session.id);
    try {
      const deleted = await runSessionAction(session.id, 'delete', { activeSessionId: null });
      if (!deleted) return;
      refreshBotProfiles();
    } catch {
      toast.error(t('ccAgent.sidebar.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const menuSession = contextMenu
    ? conversations.find((session) => session.id === contextMenu.sessionId) ?? null
    : null;

  return (
    <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-5 pb-12 pt-8 sm:px-8 sm:pt-12">
        <div className="flex flex-col gap-5 border-b border-[var(--border-default)] pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <BotAvatar bot={bot} size="lg" />
            <div className="min-w-0">
              <h1 className="text-22 font-medium leading-tight text-[var(--text-primary)]">
                {t('bots.chat.directoryTitle', { name: bot.name })}
              </h1>
              <p className="mt-1.5 text-13 leading-5 text-[var(--text-secondary)]">
                {t('bots.chat.directoryDescription')}
              </p>
            </div>
          </div>
          <Button
            variant="cta"
            size="lg"
            type="button"
            loading={creating}
            disabled={creating}
            onClick={() => void createConversation()}
            className="shrink-0"
          >
            <Plus size={16} />
            {t('bots.chat.newSession')}
          </Button>
        </div>

        {conversations.length > 1 ? (
          <div className="pt-5">
            <div className="relative">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <Input
                value={searchQuery}
                onChange={setSearchQuery}
                size="md"
                placeholder={t('bots.chat.searchPlaceholder')}
                ariaLabel={t('bots.chat.searchPlaceholder')}
                inputClassName="pl-9"
                trailing={
                  searchQuery ? (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label={t('bots.chat.clearSearch')}
                      className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <X size={13} />
                    </button>
                  ) : undefined
                }
              />
            </div>
          </div>
        ) : null}

        {conversations.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
              <MessageCircle size={20} />
            </span>
            <h2 className="mt-5 text-16 font-medium text-[var(--text-primary)]">
              {t('bots.chat.emptyTitle')}
            </h2>
            <p className="mt-2 max-w-md text-13 leading-5 text-[var(--text-secondary)]">
              {t('bots.chat.emptyDescription', { name: bot.name })}
            </p>
            <Button
              variant="cta"
              size="lg"
              type="button"
              loading={creating}
              disabled={creating}
              onClick={() => void createConversation()}
              className="mt-6"
            >
              <Plus size={16} />
              {t('bots.chat.newSession')}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <p className="text-14 font-medium text-[var(--text-primary)]">
              {t('bots.chat.noSearchResults')}
            </p>
            <Button
              variant="secondary"
              size="md"
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-4"
            >
              {t('bots.chat.clearSearch')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col pt-5">
            {groups.map((group) => (
              <section key={group.key} aria-labelledby={'conversation-date-' + group.key} className="pb-6">
                <h2
                  id={'conversation-date-' + group.key}
                  className="mb-2.5 px-1 text-12 font-medium text-[var(--text-tertiary)]"
                >
                  {group.label}
                </h2>
                <div className="flex flex-col gap-2">
                  {group.sessions.map((session) => {
                    const isEditing = editingId === session.id;
                    const isDeleting = deletingId === session.id;
                    const displayTitle = conversationDisplayTitle(
                      session,
                      bot.name,
                      t,
                      optimisticTitles[session.id],
                    );
                    const showMainBadge =
                      session.role === 'canonical' && displayTitle !== t('bots.chat.mainConversation');
                    const activityAt = conversationActivityAt(session);
                    const relativeTime = formatBotListTimestamp(activityAt, now, t);
                    const absoluteTime = activityAt > 0 ? formatSidebarTimeAbsolute(new Date(activityAt).toISOString()) : '';
                    const liveActivity = islandActivity.get(session.id);
                    const isRunning = liveActivity?.phase === 'running';
                    const previewText = (session.preview ?? '').replace(/\s+/g, ' ').trim();
                    return (
                      <div
                        key={session.id}
                        data-testid={'bot-conversation-row-' + session.id}
                        onClick={() => openConversation(session.id)}
                        onContextMenu={(event) => {
                          if (isEditing) {
                            event.stopPropagation();
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          setContextMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget || isEditing) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openConversation(session.id);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={displayTitle}
                        className={cn(
                          'group relative flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-left transition-colors',
                          'hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                          contextMenu?.sessionId === session.id && 'bg-[var(--surface-hover)]',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            {isEditing ? (
                              <SessionRenameInput
                                sessionId={session.id}
                                value={editValue}
                                onValueChange={setEditValue}
                                onCommit={(raw) => void commitRename(session, raw)}
                                onCancel={cancelRename}
                                containerClassName="min-w-0 flex-1"
                                inputClassName="h-7 text-14 font-medium text-[var(--text-primary)]"
                              />
                            ) : (
                              <>
                                <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--text-primary)]">
                                  {displayTitle}
                                </span>
                                {showMainBadge ? (
                                  <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-normal text-[var(--text-tertiary)]">
                                    {t('bots.chat.mainConversation')}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </div>

                          <div
                            className="flex shrink-0 items-center gap-1"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {!isEditing ? (
                              <div className="flex items-center gap-0.5">
                                <Tip text={t('ccAgent.sidebar.sessionMenu.rename')} side="top">
                                  <button
                                    type="button"
                                    disabled={deletingId !== null}
                                    onClick={() => startRename(session)}
                                    aria-label={t('ccAgent.sidebar.sessionMenu.rename')}
                                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                                  >
                                    <Pencil size={13} />
                                  </button>
                                </Tip>
                                <Tip text={t('bots.chat.deleteCurrent')} side="top">
                                  <button
                                    type="button"
                                    disabled={deletingId !== null}
                                    onClick={() => void deleteConversation(session)}
                                    aria-label={t('bots.chat.deleteCurrent')}
                                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                                  >
                                    {isDeleting ? <Spinner size={13} /> : <Trash2 size={13} />}
                                  </button>
                                </Tip>
                              </div>
                            ) : null}
                            {relativeTime ? (
                              <time
                                dateTime={activityAt > 0 ? new Date(activityAt).toISOString() : undefined}
                                title={absoluteTime || undefined}
                                className="min-w-8 text-right text-12 tabular-nums text-[var(--text-tertiary)]"
                              >
                                {relativeTime}
                              </time>
                            ) : null}
                          </div>
                        </div>

                        <div className="min-w-0 truncate text-12 leading-5">
                          {isRunning && liveActivity ? (
                            <TeammateRunningPreview>
                              <BotGenerationLabel
                                sessionId={liveActivity.sessionId}
                                phase={liveActivity.workingPhase}
                                startedAt={liveActivity.startedAtMs}
                              />
                            </TeammateRunningPreview>
                          ) : previewText ? (
                            <span className="block truncate text-[var(--text-secondary)]">
                              {previewText}
                            </span>
                          ) : (
                            <span className="block truncate text-[var(--text-tertiary)]">
                              {t('bots.chat.emptyPreview')}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <DropdownMenu
        open={contextMenu !== null && menuSession !== null}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed h-0 w-0"
            style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-40"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {menuSession ? (
            <>
              <DropdownMenuItem
                disabled={deletingId !== null}
                onSelect={() => startRename(menuSession)}
              >
                <Pencil size={14} className="mr-2" />
                {t('ccAgent.sidebar.sessionMenu.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="danger"
                disabled={deletingId !== null}
                onSelect={() => void deleteConversation(menuSession)}
              >
                <Trash2 size={14} className="mr-2" />
                {t('ccAgent.sidebar.sessionMenu.delete')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </main>
  );
}
