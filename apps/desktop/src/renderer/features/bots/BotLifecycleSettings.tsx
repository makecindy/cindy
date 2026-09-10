import { useRef, useState } from 'react';
import { PlayCircle, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotProfile } from './botStore';
import { runBotLifecycleAction } from './botStore';
import { Button } from '@/components/ui/button';
import { BotDeleteDialog } from './BotDeleteDialog';

/**
 * User-facing Bot management only. Health counters, delivery queues, Routes and
 * lifecycle event streams stay available to diagnostics, but they are not
 * settings a person should have to operate for a teammate.
 */
export function BotLifecycleSettings({
  bot,
  onOpenSession,
  mode = 'all',
  beforeAction,
  onDeleted,
}: {
  bot: BotProfile;
  mode?: 'all' | 'actions' | 'history';
  beforeAction?: () => Promise<boolean>;
  onDeleted?: (botId: string) => void;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchResult, setSearchResult] = useState<ConversationSearchResponse | null>(null);
  const [actionBusy, setActionBusy] = useState<'resume' | 'restart' | null>(null);
  const [actionError, setActionError] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const actionInFlight = useRef(false);

  const archivedSessions = bot.sessions
    .filter((item) => item.kind === 'history')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const isPaused = bot.status === 'paused';
  const isArchived = bot.status === 'archived';

  const runLifecycleAction = async (action: 'resume' | 'restart') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setRestarted(false);
    setActionBusy(action);
    setActionError(false);
    try {
      if (beforeAction && !(await beforeAction())) return;
      await runBotLifecycleAction({ botId: bot.id, action });
      setRestarted(action === 'restart');
    } catch {
      setActionError(true);
    } finally {
      actionInFlight.current = false;
      setActionBusy(null);
    }
  };

  const requestDelete = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(false);
    try {
      if (!beforeAction || (await beforeAction())) setDeleting(true);
    } catch {
      setActionError(true);
    } finally {
      actionInFlight.current = false;
    }
  };

  const searchHistory = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    setSearchError(false);
    try {
      setSearchResult(
        await window.electronAPI.localDb.bots.searchHistory({
          botId: bot.id,
          query: trimmed,
          limit: 20,
        }),
      );
    } catch {
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  return (
    <section
      className="min-w-0"
      aria-label={t(mode === 'history' ? 'bots.historySearch.title' : 'bots.lifecycle.title')}
    >
      {mode !== 'history' ? (
        <>
          <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
            {isPaused ? (
              <button
                type="button"
                disabled={actionBusy !== null}
                onClick={() => void runLifecycleAction('resume')}
                className="flex min-h-12 w-full items-center gap-3 border-b border-[var(--border-default)] px-4 py-3 text-left text-14 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <PlayCircle size={18} />
                {t(actionBusy === 'resume' ? 'bots.lifecycle.working' : 'bots.lifecycle.resume')}
              </button>
            ) : null}
            {!isArchived && !isPaused && bot.status !== 'deleting' ? (
              <button
                type="button"
                onClick={() => void runLifecycleAction('restart')}
                disabled={actionBusy !== null}
                aria-busy={actionBusy === 'restart'}
                className="flex min-h-12 w-full items-center gap-3 border-b border-[var(--border-default)] px-4 py-3 text-left text-14 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                <RotateCcw size={18} />
                {t(
                  actionBusy === 'restart' ? 'bots.lifecycle.restarting' : 'bots.lifecycle.restart',
                )}
              </button>
            ) : null}
            <button
              type="button"
              disabled={actionBusy !== null || bot.status === 'deleting'}
              onClick={() => void requestDelete()}
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-danger)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <Trash2 size={18} />
              {t('bots.lifecycle.deleteTitle')}
            </button>
          </div>
          <p className="mt-2 px-3 text-12 leading-5 text-[var(--text-secondary)]">
            {t(
              isPaused
                ? 'bots.lifecycle.pausedDescription'
                : isArchived
                  ? 'bots.lifecycle.stoppedDescription'
                  : 'bots.lifecycle.restartDescription',
            )}
          </p>
          {restarted ? (
            <p className="mt-3 text-12 text-[var(--text-secondary)]" role="status">
              {t('bots.lifecycle.restarted')}
            </p>
          ) : null}
          {actionError ? (
            <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
              {t('bots.lifecycle.actionFailed')}
            </p>
          ) : null}
          <BotDeleteDialog
            bot={deleting ? bot : null}
            onOpenChange={setDeleting}
            onDeleted={(id) => {
              setDeleting(false);
              onDeleted?.(id);
            }}
          />
        </>
      ) : null}
      {mode !== 'actions' ? (
        <>
          <div className="px-3 pt-3">
            <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
              {t('bots.historySearch.description')}
            </p>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void searchHistory();
              }}
            >
              <input
                aria-label={t('bots.historySearch.title')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('bots.historySearch.placeholder')}
                className="h-9 min-w-0 flex-1 rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
              />
              <Button
                type="submit"
                variant="secondary"
                size="lg"
                disabled={searching || !query.trim()}
              >
                <Search size={14} />
                {searching ? t('bots.historySearch.searching') : t('bots.historySearch.search')}
              </Button>
            </form>
            {searchError ? (
              <p className="mt-3 text-11 text-[var(--text-danger)]">
                {t('bots.historySearch.failed')}
              </p>
            ) : searchResult ? (
              searchResult.results.length === 0 ? (
                <p className="mt-3 text-11 text-[var(--text-tertiary)]">
                  {t('bots.historySearch.empty')}
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {searchResult.results.map((item) => {
                    const hit = item.contentHit;
                    return (
                      <button
                        type="button"
                        key={item.session.id}
                        onClick={() =>
                          onOpenSession(
                            item.session.id,
                            hit
                              ? {
                                  kind: 'conversation-search',
                                  sessionId: item.session.id,
                                  messageId: hit.messageId,
                                  messageClientId: hit.messageClientId,
                                }
                              : undefined,
                          )
                        }
                        className="rounded-xl border border-[var(--border-default)] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                      >
                        <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                          {item.session.title}
                        </span>
                        {hit ? (
                          <span className="mt-1 line-clamp-2 block text-11 leading-5 text-[var(--text-secondary)]">
                            {hit.preview}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-10 text-[var(--text-tertiary)]">
                          {new Date(hit?.createdAt ?? item.session.updatedAt).toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )
            ) : null}
          </div>

          <div className="mt-4 px-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-13 font-medium text-[var(--text-primary)]">
                {t('bots.historyTitle')}
              </p>
              <span className="text-11 text-[var(--text-tertiary)]">{archivedSessions.length}</span>
            </div>
            {archivedSessions.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-11 text-[var(--text-tertiary)]">
                {t('bots.historyEmpty')}
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {archivedSessions.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onOpenSession(item.id)}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-12 text-[var(--text-primary)]">
                        {item.title}
                      </span>
                      <span className="block text-10 text-[var(--text-tertiary)]">
                        {new Date(item.updatedAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="text-11 text-[var(--text-secondary)]">{t('bots.open')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
