import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import type { BotDeliveryView } from '../../../shared/botDelivery';
import type {
  BotHealthReport,
  BotLifecycleEventView,
} from '../../../shared/botLifecycle';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotProfile } from './botStore';
import { runBotLifecycleAction } from './botStore';

function healthIcon(status: BotHealthReport['status']) {
  if (status === 'healthy') return <CheckCircle2 size={16} className="text-[var(--status-success)]" />;
  if (status === 'paused') return <Clock3 size={16} className="text-[var(--text-tertiary)]" />;
  return <AlertTriangle size={16} className="text-[var(--warning-fg)]" />;
}

function healthTone(status: BotHealthReport['status']): string {
  if (status === 'healthy') return 'text-[var(--status-success)]';
  if (status === 'paused') return 'text-[var(--text-tertiary)]';
  return 'text-[var(--warning-fg)]';
}

export function BotLifecycleSettings({
  bot,
  onOpenSession,
}: {
  bot: BotProfile;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const [health, setHealth] = useState<BotHealthReport | null>(null);
  const [events, setEvents] = useState<BotLifecycleEventView[]>([]);
  const [deliveries, setDeliveries] = useState<BotDeliveryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchResult, setSearchResult] = useState<ConversationSearchResponse | null>(null);
  const [actionBusy, setActionBusy] = useState<
    'pause' | 'resume' | 'archive' | 'restore' | 'delete' | null
  >(null);
  const [actionError, setActionError] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [worktreeDisposition, setWorktreeDisposition] = useState<'retain' | 'recycle'>('retain');
  const [keepTaskHistory, setKeepTaskHistory] = useState(true);
  const [confirmName, setConfirmName] = useState('');
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [nextHealth, nextEvents, nextDeliveries] = await Promise.all([
        window.electronAPI.localDb.bots.health(bot.id),
        window.electronAPI.localDb.bots.lifecycleEvents({ botId: bot.id, limit: 50 }),
        window.electronAPI.maker.botDeliveries.list(bot.id, 100),
      ]);
      setHealth(nextHealth);
      setEvents(nextEvents);
      setDeliveries(nextDeliveries);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    setSearchResult(null);
    setQuery('');
    void load();
    return window.electronAPI.maker.botDeliveries.onChanged((payload) => {
      if (payload.botId === bot.id) void load();
    });
  }, [bot.id, load]);

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
      await load();
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(null);
    }
  };

  const archiveBot = async () => {
    setActionBusy('archive');
    setActionError(false);
    try {
      await runBotLifecycleAction({
        botId: bot.id,
        action: 'archive',
        worktreeDisposition,
      });
      setArchiveOpen(false);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(null);
    }
  };

  const restoreBot = async () => {
    setActionBusy('restore');
    setActionError(false);
    try {
      await runBotLifecycleAction({ botId: bot.id, action: 'restore' });
      await load();
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(null);
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
        keepTaskHistory,
        worktreeDisposition,
      });
      setDeleteOpen(false);
      navigate('/bots', { replace: true });
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(null);
    }
  };

  const retryDelivery = async (delivery: BotDeliveryView) => {
    const duplicateRisk = delivery.diagnostic?.retrySafe === false;
    if (duplicateRisk) {
      const approved = await confirm({
        title: t('bots.lifecycle.deliveries.duplicateTitle'),
        description: t('bots.lifecycle.deliveries.duplicateDescription', {
          count: delivery.diagnostic?.sentMediaCount ?? 0,
        }),
        confirmText: t('bots.lifecycle.deliveries.duplicateConfirm'),
        cancelText: t('commonUi.confirmDialog.cancel'),
        confirmVariant: 'destructive',
      });
      if (!approved) return;
    }
    setRetryingDeliveryId(delivery.id);
    setActionError(false);
    try {
      await window.electronAPI.maker.botDeliveries.retry(bot.id, delivery.id, duplicateRisk);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setRetryingDeliveryId(null);
    }
  };

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <Activity size={16} />
            {t('bots.lifecycle.title')}
          </div>
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.lifecycle.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('bots.lifecycle.refresh')}
          className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <RefreshCcw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] p-4">
        <div>
          <p className="text-12 font-medium text-[var(--text-primary)]">
            {isArchived
              ? t('bots.lifecycle.archivedTitle')
              : isPaused
                ? t('bots.lifecycle.pausedTitle')
                : t('bots.lifecycle.activeTitle')}
          </p>
          <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
            {isArchived
              ? t('bots.lifecycle.archivedDescription')
              : isPaused
              ? t('bots.lifecycle.pausedDescription')
              : t('bots.lifecycle.activeDescription')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {isArchived ? (
            <button
              type="button"
              onClick={() => void restoreBot()}
              disabled={actionBusy !== null}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
            >
              <RotateCcw size={15} />
              {actionBusy === 'restore' ? t('bots.lifecycle.working') : t('bots.lifecycle.restore')}
            </button>
          ) : (
            <>
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
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                disabled={actionBusy !== null}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                <Archive size={15} /> {t('bots.lifecycle.archive')}
              </button>
            </>
          )}
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

      {loadError ? (
        <p className="mt-4 rounded-xl bg-[var(--danger-bg-soft)] px-3 py-3 text-12 text-[var(--text-danger)]">
          {t('bots.lifecycle.loadFailed')}
        </p>
      ) : health ? (
        <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-12 font-medium text-[var(--text-primary)]">
              {healthIcon(health.status)}
              {t('bots.lifecycle.health')}
            </span>
            <span className={`text-11 font-medium ${healthTone(health.status)}`}>
              {t(`bots.lifecycle.healthStatus.${health.status}`)}
            </span>
          </div>
          {health.issues.length === 0 ? (
            <p className="mt-2 text-11 leading-5 text-[var(--text-tertiary)]">
              {t('bots.lifecycle.noIssues')}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {health.issues.map((issue) => (
                <li key={issue.code} className="flex items-start gap-2 text-11 leading-5 text-[var(--text-secondary)]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
                  {t(`bots.lifecycle.issues.${issue.code}`, { count: issue.count ?? 1 })}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid gap-2 text-10 text-[var(--text-tertiary)] sm:grid-cols-2">
            <span>{t('bots.lifecycle.routesCount', { count: health.counts.routes })}</span>
            <span>{t('bots.lifecycle.automationsCount', { count: health.counts.automations })}</span>
            <span>{t('bots.lifecycle.deliveriesCount', { count: health.counts.deliveries })}</span>
            <span>{t('bots.lifecycle.workspacesCount', { count: health.counts.workspaceLeases })}</span>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-12 font-medium text-[var(--text-primary)]">
              {t('bots.lifecycle.deliveries.title')}
            </p>
            <p className="mt-1 text-11 leading-5 text-[var(--text-tertiary)]">
              {t('bots.lifecycle.deliveries.description')}
            </p>
          </div>
          <span className="text-11 text-[var(--text-tertiary)]">{deliveries.length}</span>
        </div>
        {deliveries.length === 0 ? (
          <p className="mt-3 text-11 text-[var(--text-tertiary)]">
            {t('bots.lifecycle.deliveries.empty')}
          </p>
        ) : (
          <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {deliveries.map((delivery) => {
              const retryable = delivery.status === 'failed' || delivery.status === 'dead-letter';
              const progress = delivery.diagnostic;
              return (
                <div key={delivery.id} className="rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-[var(--text-primary)]">
                      {delivery.channelKind ?? t('bots.lifecycle.deliveries.local')}
                      {delivery.routeKey ? ` · ${delivery.routeKey}` : ''}
                    </span>
                    <span className={delivery.status === 'delivered'
                      ? 'text-[var(--status-success)]'
                      : retryable
                        ? 'text-[var(--text-danger)]'
                        : 'text-[var(--text-tertiary)]'}>
                      {t(`bots.lifecycle.deliveries.status.${delivery.status}`)}
                    </span>
                  </div>
                  <p className="mt-1 text-[var(--text-tertiary)]">
                    {delivery.payloadKind} · {t('bots.lifecycle.deliveries.attempts', { count: delivery.attempts })}
                    {' · '}{new Date(delivery.updatedAt).toLocaleString()}
                  </p>
                  {progress ? (
                    <p className="mt-1 text-[var(--text-tertiary)]">
                      {[
                        progress.textMessageId ? t('bots.lifecycle.deliveries.textSent') : null,
                        progress.sentMediaCount > 0
                          ? t('bots.lifecycle.deliveries.mediaSent', { count: progress.sentMediaCount })
                          : null,
                        progress.committedFinal ? t('bots.lifecycle.deliveries.finalCommitted') : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                  {delivery.lastError ? (
                    <p className="mt-1 whitespace-pre-wrap text-[var(--text-danger)]">{delivery.lastError}</p>
                  ) : null}
                  {retryable ? (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void retryDelivery(delivery)}
                        disabled={retryingDeliveryId !== null}
                        className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                      >
                        <span className={retryingDeliveryId === delivery.id ? 'inline-flex animate-spin motion-reduce:animate-none' : 'inline-flex'}>
                          <RefreshCcw size={12} />
                        </span>
                        {retryingDeliveryId === delivery.id
                          ? t('bots.lifecycle.deliveries.retrying')
                          : t('bots.lifecycle.deliveries.retry')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
        <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.historySearch.title')}</p>
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
          <p className="mt-3 text-11 text-[var(--text-danger)]">{t('bots.historySearch.failed')}</p>
        ) : searchResult ? (
          searchResult.results.length === 0 ? (
            <p className="mt-3 text-11 text-[var(--text-tertiary)]">{t('bots.historySearch.empty')}</p>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.historyTitle')}</p>
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
                    <span className="block truncate text-12 text-[var(--text-primary)]">{item.title}</span>
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

        <div>
          <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.lifecycle.timeline')}</p>
          {events.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-11 text-[var(--text-tertiary)]">
              {t('bots.lifecycle.noEvents')}
            </p>
          ) : (
            <ol className="mt-3 flex flex-col gap-3">
              {events.map((item) => (
                <li key={item.id} className="flex gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
                  <span className="min-w-0">
                    <span className="block text-11 text-[var(--text-secondary)]">
                      {t(`bots.lifecycle.events.${item.eventType}`, { defaultValue: item.eventType })}
                    </span>
                    <span className="block text-10 text-[var(--text-tertiary)]">
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">{t('bots.lifecycle.archiveTitle')}</Dialog.Title>
                <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.lifecycle.archiveDescription')}</Dialog.Description>
              </div>
              <Dialog.Close className="rounded-lg p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"><X size={16} /></Dialog.Close>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {(['retain', 'recycle'] as const).map((value) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-default)] p-3 hover:bg-[var(--surface-hover)]">
                  <input type="radio" name="archive-worktree" checked={worktreeDisposition === value} onChange={() => setWorktreeDisposition(value)} className="mt-1" />
                  <span><span className="block text-12 font-medium text-[var(--text-primary)]">{t(`bots.lifecycle.worktree.${value}`)}</span><span className="mt-1 block text-11 leading-5 text-[var(--text-tertiary)]">{t(`bots.lifecycle.worktree.${value}Description`)}</span></span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t('bots.cancel')}</Dialog.Close>
              <button type="button" onClick={() => void archiveBot()} disabled={actionBusy !== null} className="h-9 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50">{actionBusy === 'archive' ? t('bots.lifecycle.working') : t('bots.lifecycle.archive')}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-16 font-medium text-[var(--text-danger)]">{t('bots.lifecycle.deleteTitle')}</Dialog.Title>
                <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.lifecycle.deleteDescription', { name: bot.name })}</Dialog.Description>
              </div>
              <Dialog.Close className="rounded-lg p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"><X size={16} /></Dialog.Close>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {(['retain', 'recycle'] as const).map((value) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-default)] p-3 hover:bg-[var(--surface-hover)]">
                  <input type="radio" name="delete-worktree" checked={worktreeDisposition === value} onChange={() => setWorktreeDisposition(value)} className="mt-1" />
                  <span><span className="block text-12 font-medium text-[var(--text-primary)]">{t(`bots.lifecycle.worktree.${value}`)}</span><span className="mt-1 block text-11 leading-5 text-[var(--text-tertiary)]">{t(`bots.lifecycle.worktree.${value}Description`)}</span></span>
                </label>
              ))}
            </div>
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--border-default)] p-3 text-12 text-[var(--text-secondary)]">
              <input type="checkbox" checked={keepTaskHistory} onChange={(event) => setKeepTaskHistory(event.target.checked)} className="mt-0.5" />
              <span>{t('bots.lifecycle.keepHistory')}</span>
            </label>
            <label className="mt-4 block text-12 text-[var(--text-secondary)]">
              {t('bots.lifecycle.confirmName', { name: bot.name })}
              <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]" />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t('bots.cancel')}</Dialog.Close>
              <button type="button" onClick={() => void deleteBot()} disabled={actionBusy !== null || confirmName !== bot.name} className="h-9 rounded-lg bg-[var(--text-danger)] px-4 text-12 font-medium text-white disabled:opacity-50">{actionBusy === 'delete' ? t('bots.lifecycle.working') : t('bots.lifecycle.delete')}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
