import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bot,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  PauseCircle,
  Plus,
  Settings2,
  Upload,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSidebarCollapsedState, useRegisterSidebarUpper } from '../feature-context';
import type { BotHealthStatus } from '../../../shared/botLifecycle';
import type { BotInboxItemView } from '../../../shared/botSessionEvents';
import { getBotHealth, useBotProfiles } from './botStore';

const CHANNEL_LABELS = {
  telegram: 'Telegram',
  feishu: 'Feishu',
  slack: 'Slack',
  discord: 'Discord',
  wechat: 'WeChat',
  dingtalk: 'DingTalk',
  wecom: 'WeCom',
  x: 'X',
  local: 'Local',
} as const;

const AVATAR_COLORS: Record<string, string> = {
  violet: 'var(--accent-cta-bg)',
  blue: 'var(--focus-ring-soft)',
  amber: 'var(--text-secondary)',
  graphite: 'var(--text-primary)',
};

function BotsSidebarContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId } = useParams();
  const bots = useBotProfiles();
  const activeBots = bots.filter((bot) => bot.status !== 'archived');
  const archivedBots = bots.filter((bot) => bot.status === 'archived');
  const collapsed = useSidebarCollapsedState();
  const [healthByBotId, setHealthByBotId] = useState<Record<string, BotHealthStatus>>({});
  const [attentionByBotId, setAttentionByBotId] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const visible = [...activeBots, ...archivedBots];
    void Promise.allSettled(
      visible.map(async (bot) => [bot.id, (await getBotHealth(bot.id)).status] as const),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, BotHealthStatus> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
      }
      setHealthByBotId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [bots]);

  useEffect(() => {
    let cancelled = false;
    const load = async (targetBotId?: string) => {
      const targets = targetBotId ? bots.filter((bot) => bot.id === targetBotId) : bots;
      const settled = await Promise.allSettled(
        targets.map(
          async (bot) =>
            [bot.id, await window.electronAPI.maker.botInbox.list(bot.id, 100)] as const,
        ),
      );
      if (cancelled) return;
      setAttentionByBotId((previous) => {
        const next = { ...previous };
        for (const result of settled) {
          if (result.status !== 'fulfilled') continue;
          const [id, items] = result.value as readonly [string, BotInboxItemView[]];
          next[id] = items.filter(
            (item) =>
              item.status === 'pending' || item.status === 'processing' || item.status === 'failed',
          ).length;
        }
        return next;
      });
    };
    void load();
    const unsubscribe = window.electronAPI.maker.botInbox.onChanged((payload) => {
      void load(payload.botId);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bots]);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 pt-3">
        <button
          type="button"
          onClick={() => navigate('/bots')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.title')}
        >
          <Bot size={16} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/bots?add=1')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.add')}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/bots?import=1')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.portability.import')}
        >
          <Upload size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
      <div className="flex items-center justify-between px-3 pb-2">
        <div className="flex items-center gap-2 text-12 font-medium text-[var(--sidebar-list-muted)]">
          <Bot size={14} />
          <span>{t('bots.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate('/bots?import=1')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]"
            aria-label={t('bots.portability.import')}
          >
            <Upload size={14} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/bots?add=1')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]"
            aria-label={t('bots.add')}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {activeBots.length === 0 && archivedBots.length === 0 ? (
          <button
            type="button"
            onClick={() => navigate('/bots?add=1')}
            className="mx-1 flex w-[calc(100%-8px)] flex-col items-start gap-1 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-left text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <span className="font-medium text-[var(--text-primary)]">{t('bots.emptyTitle')}</span>
            <span>{t('bots.emptyDescription')}</span>
          </button>
        ) : (
          <div className="flex flex-col gap-1">
            {activeBots.map((bot) => {
              const selected = bot.id === botId;
              const mountedChannels = (bot.channels ?? [])
                .filter((channel) => channel.enabled)
                .map((channel) => CHANNEL_LABELS[channel.kind]);
              const latestRoute = (bot.routes ?? [])
                .filter((route) => route.status !== 'archived')
                .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))[0];
              const latestChannel = latestRoute
                ? bot.channels?.find((channel) => channel.id === latestRoute.channelId)?.kind
                : undefined;
              const channelSummary = latestChannel
                ? CHANNEL_LABELS[latestChannel]
                : mountedChannels.length > 0
                  ? mountedChannels.join(' · ')
                  : CHANNEL_LABELS.local;
              const health = healthByBotId[bot.id];
              const attention = attentionByBotId[bot.id] ?? 0;
              return (
                <button
                  type="button"
                  key={bot.id}
                  onClick={() => navigate(`/bots/${bot.id}`)}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors',
                    selected
                      ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                      : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
                  )}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm"
                    style={{
                      backgroundColor: AVATAR_COLORS[bot.avatarColor] ?? AVATAR_COLORS.violet,
                    }}
                  >
                    <span aria-hidden>{bot.avatar || (bot.channel === 'local' ? '✦' : '🤖')}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-13 font-medium">{bot.name}</span>
                    <span className="block truncate text-10 opacity-70">{channelSummary}</span>
                  </span>
                  {attention > 0 ? (
                    <span
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-cta-bg)] px-1 text-10 font-medium text-[var(--accent-pure-cta-fg)]"
                      aria-label={t('bots.inbox.sidebarAttention', { count: attention })}
                    >
                      {attention > 99 ? '99+' : attention}
                    </span>
                  ) : null}
                  {health === 'recovering' ? (
                    <LoaderCircle
                      size={13}
                      className="shrink-0 animate-spin text-[var(--text-secondary)]"
                      aria-label={t('bots.lifecycle.healthStatus.recovering')}
                    />
                  ) : health === 'attention' ? (
                    <CircleAlert
                      size={13}
                      className="shrink-0 text-[var(--text-danger)]"
                      aria-label={t('bots.lifecycle.healthStatus.attention')}
                    />
                  ) : health === 'paused' ? (
                    <PauseCircle
                      size={13}
                      className="shrink-0 text-[var(--text-tertiary)]"
                      aria-label={t('bots.lifecycle.healthStatus.paused')}
                    />
                  ) : health === 'healthy' ? (
                    <CheckCircle2
                      size={13}
                      className="shrink-0 text-[var(--status-success)]"
                      aria-label={t('bots.lifecycle.healthStatus.healthy')}
                    />
                  ) : null}
                  <ChevronRight size={14} className="shrink-0 opacity-50" />
                </button>
              );
            })}
            {archivedBots.length > 0 ? (
              <div className="mt-3 border-t border-[var(--border-default)] pt-3">
                <div className="mb-1 flex items-center gap-2 px-3 text-10 font-medium text-[var(--sidebar-list-muted)]">
                  <Archive size={12} />
                  <span>{t('bots.lifecycle.archivedBots')}</span>
                </div>
                {archivedBots.map((bot) => {
                  const selected = bot.id === botId;
                  return (
                    <button
                      type="button"
                      key={bot.id}
                      onClick={() => navigate(`/bots/${bot.id}?settings=1`)}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors',
                        selected
                          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                          : 'text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover',
                      )}
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm opacity-70"
                        style={{
                          backgroundColor: AVATAR_COLORS[bot.avatarColor] ?? AVATAR_COLORS.violet,
                        }}
                      >
                        <span aria-hidden>{bot.avatar || '🤖'}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-13 font-medium">
                        {bot.name}
                      </span>
                      <ChevronRight size={14} className="shrink-0 opacity-50" />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => navigate(botId ? `/bots/${botId}?settings=1` : '/bots')}
        disabled={!botId}
        className="mb-1 flex h-8 items-center gap-2 rounded-lg px-3 text-12 text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Settings2 size={14} />
        {t('bots.settings')}
      </button>
    </div>
  );
}

export function BotsSidebar() {
  const content = useMemo(() => <BotsSidebarContent />, []);
  useRegisterSidebarUpper(content);
  return null;
}
