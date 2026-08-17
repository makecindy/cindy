import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  LoaderCircle,
  PauseCircle,
  RefreshCcw,
  RotateCcw,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_CONTROL_BOT_EVENT_RULE,
  type BotEventSubscriptionView,
  type BotInboxItemView,
  type BotInboxStatus,
} from '../../../shared/botSessionEvents';
import type { BotProfile } from './botStore';
import { Switch } from '@/components/ui/switch';

const CONTROL_SUBSCRIPTION_PREFIX = 'bot-control-events:';

function statusIcon(status: BotInboxStatus) {
  if (status === 'handled') return CheckCircle2;
  if (status === 'processing') return LoaderCircle;
  if (status === 'failed') return CircleAlert;
  if (status === 'skipped') return PauseCircle;
  return Clock3;
}

export function BotEventInboxSettings({ bot }: { bot: BotProfile }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [subscriptions, setSubscriptions] = useState<BotEventSubscriptionView[]>([]);
  const [items, setItems] = useState<BotInboxItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextSubscriptions, nextItems] = await Promise.all([
        window.electronAPI.maker.botInbox.listSubscriptions(bot.id),
        window.electronAPI.maker.botInbox.list(bot.id, 80),
      ]);
      setSubscriptions(nextSubscriptions);
      setItems(nextItems);
      setError(null);
    } catch {
      setError(t('bots.inbox.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [bot.id, t]);

  useEffect(() => {
    setLoading(true);
    void load();
    return window.electronAPI.maker.botInbox.onChanged((payload) => {
      if (payload.botId === bot.id) void load();
    });
  }, [bot.id, load]);

  const controlSubscription = useMemo(
    () => subscriptions.find((item) => item.id === `${CONTROL_SUBSCRIPTION_PREFIX}${bot.id}`),
    [bot.id, subscriptions],
  );
  const watching = controlSubscription?.status === 'active';
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const processingCount = items.filter((item) => item.status === 'processing').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;

  const setWatching = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.maker.botInbox.upsertSubscription({
        id: `${CONTROL_SUBSCRIPTION_PREFIX}${bot.id}`,
        botId: bot.id,
        name: t('bots.inbox.defaultSubscriptionName'),
        status: enabled ? 'active' : 'paused',
        rule: controlSubscription?.rule ?? DEFAULT_CONTROL_BOT_EVENT_RULE,
      });
      await load();
    } catch {
      setError(t('bots.inbox.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const retry = async (itemId: string) => {
    setRetryingId(itemId);
    setError(null);
    try {
      await window.electronAPI.maker.botInbox.retry(bot.id, itemId);
      await load();
    } catch {
      setError(t('bots.inbox.retryFailed'));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <BellRing size={16} />
            {t('bots.inbox.title')}
          </div>
          <p className="mt-1 max-w-2xl text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.inbox.description')}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-12 text-[var(--text-secondary)]">
          <Switch
            checked={watching}
            disabled={saving || bot.status !== 'active'}
            onCheckedChange={(next) => void setWatching(next)}
            aria-label={t('bots.inbox.watchTaskStates')}
          />
          {saving ? t('bots.inbox.saving') : t('bots.inbox.watchTaskStates')}
        </label>
      </div>

      {/* Three zeroes are noise before anything has arrived — the counts only
          appear once there is something to count. */}
      {items.length > 0 ? (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-[var(--surface)] px-3 py-2">
            <span className="block text-10 text-[var(--text-tertiary)]">{t('bots.inbox.pending')}</span>
            <span className="mt-1 block text-16 font-medium text-[var(--text-primary)]">{pendingCount}</span>
          </div>
          <div className="rounded-lg bg-[var(--surface)] px-3 py-2">
            <span className="block text-10 text-[var(--text-tertiary)]">{t('bots.inbox.processing')}</span>
            <span className="mt-1 block text-16 font-medium text-[var(--text-primary)]">{processingCount}</span>
          </div>
          <div className="rounded-lg bg-[var(--surface)] px-3 py-2">
            <span className="block text-10 text-[var(--text-tertiary)]">{t('bots.inbox.failed')}</span>
            <span className="mt-1 block text-16 font-medium text-[var(--text-primary)]">{failedCount}</span>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.inbox.timeline')}</p>
          <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
            {watching ? t('bots.inbox.ruleSummary') : t('bots.inbox.pausedSummary')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          aria-label={t('bots.inbox.refresh')}
        >
          <RefreshCcw
            size={14}
            className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
          />
        </button>
      </div>

      {error ? <p className="mt-3 break-words text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]" role="alert">{error}</p> : null}
      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-11 text-[var(--text-tertiary)]">
          <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />{' '}
          {t('bots.inbox.loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] px-4 py-5 text-12 leading-5 text-[var(--text-secondary)]">
          {watching ? t('bots.inbox.emptyWatching') : t('bots.inbox.emptyPaused')}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {items.map((item) => {
            const StatusIcon = statusIcon(item.status);
            return (
              <article key={item.id} className="rounded-xl border border-[var(--border-default)] px-3 py-3">
                <div className="flex items-start gap-3">
                  <StatusIcon
                    size={15}
                    className={item.status === 'processing' ? 'mt-0.5 shrink-0 animate-spin text-[var(--text-secondary)] motion-reduce:animate-none' : item.status === 'failed' ? 'mt-0.5 shrink-0 text-[var(--text-danger)]' : 'mt-0.5 shrink-0 text-[var(--text-tertiary)]'}
                    aria-label={t(`bots.inbox.status.${item.status}`)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p
                        className="truncate text-12 font-medium text-[var(--text-primary)]"
                        title={item.event.title || t('bots.inbox.untitledTask')}
                      >
                        {item.event.title || t('bots.inbox.untitledTask')}
                      </p>
                      <time className="shrink-0 text-10 text-[var(--text-tertiary)]">
                        {new Date(item.receivedAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="mt-1 text-11 text-[var(--text-secondary)]">
                      {t(`bots.inbox.events.${item.event.eventType}`, { defaultValue: item.event.eventType })}
                      {item.event.guardianAnomaly
                        ? ` · ${t(`bots.inbox.guardianAnomalies.${item.event.guardianAnomaly.kind}`)}`
                        : item.event.workflowState
                          ? ` · ${item.event.workflowState.label ?? item.event.workflowState.key}`
                          : item.event.decisionState
                            ? ` · ${item.event.decisionState}`
                            : ''}
                    </p>
                    {item.resultText ? (
                      <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-11 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                        {item.resultText}
                      </p>
                    ) : item.lastError ? (
                      <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-11 leading-5 text-[var(--text-danger)] [overflow-wrap:anywhere]">{item.lastError}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.status === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => void retry(item.id)}
                        disabled={retryingId === item.id}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                        aria-label={t('bots.inbox.retry')}
                      >
                        <RotateCcw
                          size={13}
                          className={retryingId === item.id ? 'animate-spin motion-reduce:animate-none' : undefined}
                        />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => navigate(`/cc-agent/${item.event.sessionId}`)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                      aria-label={t('bots.inbox.openTask')}
                    >
                      <ExternalLink size={13} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
