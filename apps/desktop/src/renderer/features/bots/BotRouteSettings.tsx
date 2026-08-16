import { useEffect, useMemo, useState } from 'react';
import { Archive, CirclePause, CirclePlay, MessageSquarePlus, Route } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  setBotRouteStatus,
  upsertBotRoute,
  type BotChannel,
  type BotProfile,
  type BotRoute,
} from './botStore';

const CHANNEL_NAMES: Record<BotChannel, string> = {
  local: 'Local',
  telegram: 'Telegram',
  feishu: 'Feishu',
  slack: 'Slack',
  discord: 'Discord',
  wechat: 'WeChat',
  dingtalk: 'DingTalk',
  wecom: 'WeCom',
  x: 'X',
};

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function routeTone(status: BotRoute['status']): string {
  if (status === 'active') return 'text-[var(--status-success)]';
  if (status === 'error') return 'text-[var(--text-danger)]';
  return 'text-[var(--text-secondary)]';
}

function RouteCard({
  bot,
  route,
  onOpenTask,
}: {
  bot: BotProfile;
  route: BotRoute;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'pause' | 'resume' | 'archive' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channel = bot.channels?.find((item) => item.id === route.channelId);
  const isArchived = route.status === 'archived';
  const isPaused = route.status === 'paused';

  const changeStatus = async (status: 'paused' | 'offline' | 'archived') => {
    setBusy(status === 'paused' ? 'pause' : status === 'offline' ? 'resume' : 'archive');
    setError(null);
    try {
      await setBotRouteStatus(bot.id, route.id, status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-13 font-medium text-[var(--text-primary)]">
            {route.routeKey}
          </p>
          <p className="mt-1 text-11 text-[var(--text-tertiary)]">
            {channel ? CHANNEL_NAMES[channel.kind] : t('bots.routes.unknownChannel')}
            {route.principalKey ? ` · ${route.principalKey}` : ` · ${t('bots.routes.allMessages')}`}
            {route.threadKey ? ` · ${route.threadKey}` : ''}
          </p>
        </div>
        <span className={`shrink-0 text-11 ${routeTone(route.status)}`}>
          {t(`bots.routes.status.${route.status}`)}
        </span>
      </div>
      <div className="mt-3 grid gap-1 text-11 text-[var(--text-tertiary)]">
        <span>{t('bots.routes.lastActivity', { time: formatTime(route.lastActivityAt) })}</span>
        {route.projectBindingId ? <span>{t('bots.routes.projectBound')}</span> : null}
      </div>
      {error ? <p className="mt-3 text-11 text-[var(--text-danger)]">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {route.currentSessionId && !isArchived ? (
          <button
            type="button"
            onClick={() => onOpenTask(route.currentSessionId!)}
            className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            {t('bots.routes.openTask')}
          </button>
        ) : null}
        {!isArchived && !isPaused ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void changeStatus('paused')}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <CirclePause size={13} />
            {busy === 'pause' ? t('bots.routes.pausing') : t('bots.routes.pause')}
          </button>
        ) : null}
        {isPaused ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void changeStatus('offline')}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <CirclePlay size={13} />
            {busy === 'resume' ? t('bots.routes.resuming') : t('bots.routes.resume')}
          </button>
        ) : null}
        {!isArchived ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void changeStatus('archived')}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <Archive size={13} />
            {busy === 'archive' ? t('bots.routes.archiving') : t('bots.routes.archive')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BotRouteSettings({
  bot,
  onOpenTask,
}: {
  bot: BotProfile;
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const availableChannels = useMemo(
    () => (bot.channels ?? []).filter(
      (item) => item.enabled && item.kind !== 'local' && item.kind !== 'x',
    ),
    [bot.channels],
  );
  const activeProjects = useMemo(
    () => (bot.projectBindings ?? []).filter((item) => item.status === 'active'),
    [bot.projectBindings],
  );
  const [adding, setAdding] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [routeKey, setRouteKey] = useState('');
  const [principalKey, setPrincipalKey] = useState('');
  const [threadKey, setThreadKey] = useState('');
  const [projectBindingId, setProjectBindingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId || !availableChannels.some((item) => item.id === channelId)) {
      setChannelId(availableChannels[0]?.id ?? '');
    }
  }, [availableChannels, channelId]);

  const resetForm = () => {
    setAdding(false);
    setRouteKey('');
    setPrincipalKey('');
    setThreadKey('');
    setProjectBindingId('');
    setError(null);
  };

  const submit = async () => {
    if (!channelId || !routeKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await upsertBotRoute(bot.id, {
        channelId,
        routeKey: routeKey.trim(),
        principalKey: principalKey.trim() || undefined,
        threadKey: threadKey.trim() || undefined,
        projectBindingId: projectBindingId || undefined,
      });
      resetForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const visibleRoutes = (bot.routes ?? []).filter((route) => route.status !== 'archived');

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <Route size={16} />
            {t('bots.routes.title')}
          </div>
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.routes.description')}
          </p>
        </div>
        <button
          type="button"
          disabled={availableChannels.length === 0}
          onClick={() => setAdding(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MessageSquarePlus size={13} />
          {t('bots.routes.add')}
        </button>
      </div>

      {availableChannels.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">
          {t('bots.routes.mountChannelFirst')}
        </p>
      ) : null}

      {adding ? (
        <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] p-4">
          <p className="text-12 font-medium text-[var(--text-primary)]">
            {t('bots.routes.addTitle')}
          </p>
          <p className="mt-1 text-11 leading-5 text-[var(--text-secondary)]">
            {t('bots.routes.addDescription')}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.routes.channel')}
              <select
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-12 text-[var(--text-primary)]"
              >
                {availableChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {CHANNEL_NAMES[channel.kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.routes.routeKey')}
              <input
                value={routeKey}
                onChange={(event) => setRouteKey(event.target.value)}
                placeholder={t('bots.routes.routeKeyPlaceholder')}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.routes.principalKey')}
              <input
                value={principalKey}
                onChange={(event) => setPrincipalKey(event.target.value)}
                placeholder={t('bots.routes.principalKeyPlaceholder')}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
              {t('bots.routes.threadKey')}
              <input
                value={threadKey}
                onChange={(event) => setThreadKey(event.target.value)}
                placeholder={t('bots.routes.threadKeyPlaceholder')}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)]"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)] md:col-span-2">
              {t('bots.routes.project')}
              <select
                value={projectBindingId}
                onChange={(event) => setProjectBindingId(event.target.value)}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-12 text-[var(--text-primary)]"
              >
                <option value="">{t('bots.routes.botDefaultProject')}</option>
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.workingDir}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? <p className="mt-3 text-11 text-[var(--text-danger)]">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              disabled={saving}
              className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              {t('bots.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || !channelId || !routeKey.trim()}
              className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
            >
              {saving ? t('bots.routes.saving') : t('bots.routes.create')}
            </button>
          </div>
        </div>
      ) : null}

      {visibleRoutes.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">
          {t('bots.routes.empty')}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {visibleRoutes.map((route) => (
            <RouteCard key={route.id} bot={bot} route={route} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </section>
  );
}
