/**
 * The ContentHeader lockup for a teammate's canonical chat.
 *
 * A Bot chat is not a task the user manages, so it does not get the task header
 * (rename / pin / archive / export …). It gets what an IM conversation gets: who
 * you are talking to, and the way into their settings. Two entrances, both
 * leading to the same place — the name/avatar lockup itself, and the gear at the
 * right end of the bar — because "click the name" is the discoverable one and
 * "the gear is on the right" is the learned one.
 */
import { useMemo } from 'react';
import { Settings2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useRegisterContentHeader } from '../feature-context';
import { BotAvatar } from './BotAvatar';

export interface BotChatIdentity {
  id: string;
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
}

export function BotSessionContentHeader({
  bot,
  sessionId,
}: {
  bot: BotChatIdentity;
  /** 没有会话 id 就打不开那一个会话的仓库 —— 此时整枚入口不渲染,不给死按钮。 */
  sessionId?: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openSettings = () => navigate(`/bots/${bot.id}?settings=1`);

  return (
    <div
      data-testid="bot-session-content-header"
      className="flex h-full w-full min-w-0 items-center gap-2 pr-2"
    >
      <button
        type="button"
        onClick={openSettings}
        title={t('bots.settings')}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <BotAvatar bot={bot} size="xs" />
        <span className="min-w-0 truncate">{bot.name}</span>
      </button>
      <button
        type="button"
        onClick={openSettings}
        aria-label={t('bots.settings')}
        className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <Settings2 size={15} />
      </button>
    </div>
  );
}

/**
 * Registration wrapper — same contract as `SessionContentHeaderRegistration`:
 * mounting registers, unmounting clears, and only the route-owning chat instance
 * renders it.
 */
export function BotSessionContentHeaderRegistration({
  bot,
  sessionId,
}: {
  bot: BotChatIdentity;
  sessionId?: string | null;
}) {
  useRegisterContentHeader(
    useMemo(() => <BotSessionContentHeader bot={bot} sessionId={sessionId} />, [bot, sessionId]),
  );
  return null;
}
