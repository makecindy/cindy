import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { PauseCircle, PlayCircle, Search, Settings2, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotProfile } from './botStore';
import { runBotLifecycleAction } from './botStore';
import { BotSettingsBlock } from './BotSettingsBlock';

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
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchResult, setSearchResult] = useState<ConversationSearchResponse | null>(null);
  const [actionBusy, setActionBusy] = useState<'pause' | 'resume' | 'delete' | null>(null);
  const [actionError, setActionError] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const archivedSessions = bot.sessions
    .filter((item) => item.kind === 'history')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const isPaused = bot.status === 'paused';
  const isArchived = bot.status === 'archived';

  const runLifecycleAction = async (action: 'pause' | 'resume') => {
    setActionBusy(action);
    setActionError(false);
    try {
      await runBotLifecycleAction({ botId: bot.id, action });
    } catch {
      setActionError(true);
    } finally {
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
      setSearchResult(await window.electronAPI.localDb.bots.searchHistory({
        botId: bot.id,
        query: trimmed,
        limit: 20,
      }));
    } catch {
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  const deleteBot = async () => {
    setActionBusy('delete');
    setActionError(false);
    try {
      await runBotLifecycleAction({
        botId: bot.id,
        action: 'delete',
        confirmName,
        keepTaskHistory: true,
        worktreeDisposition: 'retain',
      });
      setDeleteOpen(false);
      navigate('/bots', { replace: true });
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <BotSettingsBlock
      icon={Settings2}
      title={t('bots.lifecycle.title')}
      hint={t('bots.lifecycle.description')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] p-4">
        <div>
          <p className="text-12 font-medium text-[var(--text-primary)]">
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
            <button
              type="button"
              onClick={() => void runLifecycleAction(isPaused ? 'resume' : 'pause')}
              disabled={actionBusy !== null}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              {isPaused ? <PlayCircle size={15} /> : <PauseCircle size={15} />}
              {actionBusy
                ? t('bots.lifecycle.working')
                : isPaused
                  ? t('bots.lifecycle.resume')
                  : t('bots.lifecycle.pause')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setConfirmName('');
              setDeleteOpen(true);
            }}
            disabled={actionBusy !== null}
            className="inline-flex h-9 items-center gap-2 rounded-full px-4 text-12 font-medium text-[var(--text-danger)] hover:bg-[var(--danger-bg-soft)] disabled:opacity-50"
          >
            <Trash2 size={15} /> {t('bots.lifecycle.delete')}
          </button>
        </div>
      </div>

      {actionError ? (
        <p className="mt-3 text-11 text-[var(--text-danger)]" role="alert">
          {t('bots.lifecycle.actionFailed')}
        </p>
      ) : null}

      <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
        <p className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.historySearch.title')}
        </p>
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
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('bots.historySearch.placeholder')}
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
          >
            <Search size={14} />
            {searching ? t('bots.historySearch.searching') : t('bots.historySearch.search')}
          </button>
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
                    onClick={() => onOpenSession(
                      item.session.id,
                      hit
                        ? {
                            kind: 'conversation-search',
                            sessionId: item.session.id,
                            messageId: hit.messageId,
                            messageClientId: hit.messageClientId,
                          }
                        : undefined,
                    )}
                    className="rounded-xl border border-[var(--border-default)] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                  >
                    <span className="block truncate text-12 font-medium text-[var(--text-primary)]">
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

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-12 font-medium text-[var(--text-primary)]">
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

      <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-16 font-medium text-[var(--text-danger)]">
                  {t('bots.lifecycle.deleteTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                  {t('bots.lifecycle.deleteDescription', { name: bot.name })}
                </Dialog.Description>
              </div>
              <Dialog.Close className="rounded-lg p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]">
                <X size={16} />
              </Dialog.Close>
            </div>
            <label className="mt-4 block text-12 text-[var(--text-secondary)]">
              {t('bots.lifecycle.confirmName', { name: bot.name })}
              <input
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                {t('bots.cancel')}
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void deleteBot()}
                disabled={actionBusy !== null || confirmName !== bot.name}
                className="h-9 rounded-lg bg-[var(--text-danger)] px-4 text-12 font-medium text-white disabled:opacity-50"
              >
                {actionBusy === 'delete'
                  ? t('bots.lifecycle.working')
                  : t('bots.lifecycle.delete')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </BotSettingsBlock>
  );
}
