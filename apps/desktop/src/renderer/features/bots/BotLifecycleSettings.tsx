import { useRef, useState } from 'react';
import { PauseCircle, PlayCircle, RotateCcw, Search, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotProfile } from './botStore';
import { runBotLifecycleAction } from './botStore';
import { Button } from '@/components/ui/button';

/**
 * User-facing Bot management only. Health counters, delivery queues, Routes and
 * lifecycle event streams stay available to diagnostics, but they are not
 * settings a person should have to operate for a teammate.
 */
export function BotLifecycleSettings({
  bot,
  onOpenSession,
}: {
  bot: BotProfile;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchResult, setSearchResult] = useState<ConversationSearchResponse | null>(null);
  const [actionBusy, setActionBusy] = useState<'pause' | 'resume' | 'restart' | null>(null);
  const [actionError, setActionError] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const actionInFlight = useRef(false);

  const archivedSessions = bot.sessions
    .filter((item) => item.kind === 'history')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const isPaused = bot.status === 'paused';
  const isArchived = bot.status === 'archived';

  const runLifecycleAction = async (action: 'pause' | 'resume' | 'restart') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setRestarted(false);
    setActionBusy(action);
    setActionError(false);
    try {
      await runBotLifecycleAction({ botId: bot.id, action });
      setRestarted(action === 'restart');
    } catch {
      setActionError(true);
    } finally {
      actionInFlight.current = false;
      setActionBusy(null);
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
      aria-label={t('bots.lifecycle.title')}
      className="min-w-0 border-t border-[var(--border-default)] pt-5"
    >
      <h2 className="text-14 font-medium text-[var(--text-primary)]">
        {t('bots.lifecycle.title')}
      </h2>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div>
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {isArchived
              ? t('bots.lifecycle.stoppedTitle')
              : isPaused
                ? t('bots.lifecycle.pausedTitle')
                : t('bots.lifecycle.activeTitle')}
          </p>
          <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
            {isArchived
              ? t('bots.lifecycle.stoppedDescription')
              : isPaused
                ? t('bots.lifecycle.pausedDescription')
                : t('bots.lifecycle.activeDescription')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {!isArchived ? (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void runLifecycleAction(isPaused ? 'resume' : 'pause')}
              disabled={actionBusy !== null}
            >
              {isPaused ? <PlayCircle size={15} /> : <PauseCircle size={15} />}
              {actionBusy === (isPaused ? 'resume' : 'pause')
                ? t('bots.lifecycle.working')
                : isPaused
                  ? t('bots.lifecycle.resume')
                  : t('bots.lifecycle.pause')}
            </Button>
          ) : null}
        </div>
      </div>

      {!isArchived && !isPaused && bot.status !== 'deleting' ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('bots.lifecycle.restartHint')}
            </p>
            <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.lifecycle.restartDescription')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => void runLifecycleAction('restart')}
            disabled={actionBusy !== null}
            aria-busy={actionBusy === 'restart'}
            className="ml-auto shrink-0"
          >
            <RotateCcw size={15} aria-hidden />
            {t(actionBusy === 'restart' ? 'bots.lifecycle.restarting' : 'bots.lifecycle.restart')}
          </Button>
        </div>
      ) : null}
      {restarted ? (
        <p className="mt-3 text-12 text-[var(--text-secondary)]" role="status">
          {t('bots.lifecycle.restarted')}
        </p>
      ) : null}

      {actionError ? (
        <p className="mt-3 text-11 text-[var(--text-danger)]" role="alert">
          {t('bots.lifecycle.actionFailed')}
        </p>
      ) : null}

      <details className="group mt-5">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-full px-3 py-2 text-13 text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
          {t('bots.historySearch.title')}
          <ChevronDown size={15} aria-hidden className="shrink-0 group-open:rotate-180" />
        </summary>
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
            <Button type="submit" variant="secondary" size="lg" disabled={searching || !query.trim()}>
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
      </details>
    </section>
  );
}
