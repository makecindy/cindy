import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { Session } from '@/lib/ccAgent.types';
import { BotAvatar } from './BotAvatar';
import { useSessionDelegatingBot } from './botFollowScopes';
import { ensureBotProfilesLoaded } from './botStore';

/**
 * A task a teammate opened is an ordinary task; this quiet chip in its header
 * says which teammate opened it and leads back to that teammate. A task the
 * teammate only follows keeps the sidebar's follow mark and no chip.
 */
export function BotTaskOwnerChip({ session }: { session: Session }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useEffect(() => {
    void ensureBotProfilesLoaded().catch(() => {});
  }, []);
  const bot = useSessionDelegatingBot(session);
  if (!bot) return null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/bots/${encodeURIComponent(bot.id)}`)}
      aria-label={t('bots.session.backToBot', { name: bot.name })}
      title={t('bots.session.backToBot', { name: bot.name })}
      className="ml-1.5 inline-flex h-6 min-w-0 max-w-[200px] shrink items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
      style={WINDOW_NO_DRAG_STYLE}
    >
      <BotAvatar bot={bot} size="xs" />
      <span className="truncate">{t('bots.session.ownedByBot', { name: bot.name })}</span>
    </button>
  );
}
