import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bot,
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
import { BotAvatar } from './BotAvatar';
import { botListSubtitle, formatBotListTimestamp } from './botListDisplay';
import { getBotHealth, refreshBotProfiles, useBotProfiles } from './botStore';

/** Debounce for message-driven refreshes: one turn writes many rows. */
const MESSAGE_REFRESH_DEBOUNCE_MS = 800;

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
  const now = Date.now();

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

  // A chat list has to move when a message lands. There is no Bot-scoped
  // message push, so reuse the existing localDb message broadcast and only
  // refresh when the row belongs to a Bot task (a normal Cindy chat must not
  // make the Bots list re-query).
  useEffect(() => {
    const botSessionIds = new Set<string>();
    for (const bot of bots) {
      if (bot.canonicalSessionId) botSessionIds.add(bot.canonicalSessionId);
      for (const session of bot.sessions) botSessionIds.add(session.id);
    }
    if (botSessionIds.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== 'string' || !botSessionIds.has(sessionId)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshBotProfiles();
      }, MESSAGE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
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
              const health = healthByBotId[bot.id];
              const attention = attentionByBotId[bot.id] ?? 0;
              const subtitle = botListSubtitle(bot);
              const subtitleText =
                subtitle.kind === 'placeholder' ? t('bots.list.startChat') : subtitle.text;
              const timestamp = formatBotListTimestamp(bot.lastMessageAt, now);
              return (
                <div
                  key={bot.id}
                  className={cn(
                    'group relative flex w-full items-center gap-2 rounded-xl transition-colors',
                    selected
                      ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                      : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/bots/${bot.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left"
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-13 font-medium" title={bot.name}>
                          {bot.name}
                        </span>
                        {timestamp ? (
                          <span className="shrink-0 text-10 opacity-60">{timestamp}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-11 opacity-70" title={subtitleText}>
                        {subtitleText}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-1 pr-2">
                    {attention > 0 ? (
                      <span
                        className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent-cta-bg)] px-1 text-10 font-medium text-[var(--accent-pure-cta-fg)]"
                        aria-label={t('bots.inbox.sidebarAttention', { count: attention })}
                      >
                        {attention > 99 ? '99+' : attention}
                      </span>
                    ) : null}
                    {health === 'recovering' ? (
                      <LoaderCircle
                        size={13}
                        className="shrink-0 animate-spin motion-reduce:animate-none text-[var(--text-secondary)]"
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
                    ) : null}
                    {/* Kept in the DOM (opacity, not display) so the gear stays
                        keyboard reachable and the row never shifts on hover. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/bots/${bot.id}?settings=1`);
                      }}
                      aria-label={t('bots.settings')}
                      className="flex h-6 w-6 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] opacity-0 transition-opacity hover:text-[var(--sidebar-nav-text)] focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Settings2 size={13} />
                    </button>
                  </span>
                </div>
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
                      <BotAvatar bot={bot} size="sm" className="opacity-70" />
                      <span className="min-w-0 flex-1 truncate text-13 font-medium" title={bot.name}>
                        {bot.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function BotsSidebar() {
  const content = useMemo(() => <BotsSidebarContent />, []);
  useRegisterSidebarUpper(content);
  return null;
}
