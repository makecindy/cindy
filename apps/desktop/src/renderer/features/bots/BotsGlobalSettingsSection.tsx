/**
 * Settings › 伙伴 — the settings that belong to the *feature*, not to any one
 * teammate. A single teammate's personality, memory, capabilities and schedule
 * stay on its own page; what lives here is how the whole crew reaches you, and
 * how a teammate moves between machines.
 *
 * Card geometry follows the neighbouring general-tab sections (rounded-xl / Card
 * fill / 1px Board / 20px padding).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { exportBotBundle, useBotProfiles } from './botStore';

const CARD_CLASS = cn(
  'rounded-xl p-5',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);

const ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const ROW_HINT_CLASS =
  'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';

export function BotsGlobalSettingsSection() {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const activeBots = bots.filter((bot) => bot.status !== 'archived');
  const [busyBotId, setBusyBotId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const exportBot = (botId: string) => {
    setBusyBotId(botId);
    setNotice(null);
    void exportBotBundle(botId)
      .then((result) => {
        if (result.canceled) return;
        setNotice(
          result.redactionCount
            ? t('bots.portability.exportedRedacted', { count: result.redactionCount })
            : t('bots.portability.exported'),
        );
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusyBotId(null));
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('bots.globalSettings.title')}
      </h2>
      <p className="-mt-2 text-12 leading-[1.5] text-[var(--settings-section-sublabel)] opacity-70">
        {t('bots.globalSettings.description')}
      </p>

      {/*
        新消息提醒 —— 只陈述现状,不摆开关。
        伙伴的 canonical Session 不在 DESKTOP_VISIBLE_SESSION_SOURCES 里
        (shared/sessionSource.ts),因此不经过 useSessionRunningStatus →
        notificationShowSessionEvent 那条系统通知链;桌面横幅/声音/勿扰对伙伴
        消息**根本不会触发**。之前这里摆了 banner / sound / quietHours 三个开关,
        它们只写 localStorage、没有任何消费方 —— 三个纯装饰的假开关,已删除。
        真实存在的提醒只有一种:侧栏伙伴行上的未读标记(useBotUnreadCounts),
        所以这里如实写这一条。要真接系统通知,得先把伙伴会话接进那条链,
        属于独立改动。
      */}
      <div className={cn(CARD_CLASS, 'flex flex-col gap-2')}>
        <p className={ROW_LABEL_CLASS}>{t('bots.globalSettings.notifications.title')}</p>
        <p className={ROW_HINT_CLASS}>{t('bots.globalSettings.notifications.note')}</p>
        <p className={ROW_HINT_CLASS}>{t('bots.globalSettings.notifications.footnote')}</p>
      </div>

      <div className={cn(CARD_CLASS, 'flex flex-col gap-4')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={ROW_LABEL_CLASS}>{t('bots.globalSettings.portability.importTitle')}</p>
            <p className={cn('mt-1', ROW_HINT_CLASS)}>
              {t('bots.globalSettings.portability.importHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/bots?import=1')}
            className="h-8 shrink-0 rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            {t('bots.globalSettings.portability.importAction')}
          </button>
        </div>

        <div className="min-w-0">
          <p className={ROW_LABEL_CLASS}>{t('bots.globalSettings.portability.exportTitle')}</p>
          <p className={cn('mt-1', ROW_HINT_CLASS)}>
            {t('bots.globalSettings.portability.exportHint')}
          </p>
          {activeBots.length === 0 ? (
            <p className={cn('mt-3', ROW_HINT_CLASS)}>
              {t('bots.globalSettings.portability.exportEmpty')}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {activeBots.map((bot) => (
                <li key={bot.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 truncate text-12 text-[var(--text-primary)]">
                      {bot.name}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busyBotId !== null}
                    onClick={() => exportBot(bot.id)}
                    className="h-7 shrink-0 rounded-lg border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    {busyBotId === bot.id
                      ? t('bots.portability.exporting')
                      : t('bots.globalSettings.portability.exportAction')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notice ? (
            <p className={cn('mt-3', ROW_HINT_CLASS)} role="status">
              {notice}
            </p>
          ) : null}
        </div>
      </div>

      <p className={ROW_HINT_CLASS}>{t('bots.globalSettings.rosterNote')}</p>
    </div>
  );
}
