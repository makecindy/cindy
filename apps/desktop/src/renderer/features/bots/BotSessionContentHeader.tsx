/**
 * The ContentHeader lockup for a teammate's canonical chat.
 *
 * A Bot chat is not a task the user manages, so it does not get the task header
 * (rename / pin / archive / export …). It gets what an IM conversation gets: who
 * you are talking to, and the way into their settings. Two entrances, both
 * leading to the same place — the name/avatar lockup itself, and the gear at the
 * right end of the bar — because "click the name" is the discoverable one and
 * "the gear is on the right" is the learned one. Every teammate with a live main
 * task (this computer's or another computer's) also gets the 近况 popover here —
 * where it runs (and switching computers), the user's todos and its outputs —
 * plus, for local teammates, the IM-style "add people" entry that turns this chat
 * into a group or brings the teammate into one.
 */
import { useMemo } from 'react';
import { Settings2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useRegisterContentHeader } from '../feature-context';
import { BotAddToGroupMenu } from './BotAddToGroupMenu';
import { BotAvatar } from './BotAvatar';
import { BotGlanceButton } from './BotGlancePopover';
import { useCompanionCloud } from './companionCloudStore';

export interface BotChatIdentity {
  id: string;
  templateId?: string;
  deviceId?: string;
  deviceName?: string;
  /** 伙伴主任务的 session id(本机或那台电脑上的);有它才有近况入口。名册里尚未就绪时为 null。 */
  sessionId?: string | null;
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
  /** Only the teammate's own canonical private chat (not channel routes or read-only history) can start a group. */
  canonicalChat?: boolean;
}

export function BotSessionContentHeader({ bot }: { bot: BotChatIdentity }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const cloud = useCompanionCloud();
  // A cloud companion is one teammate wherever it runs: 近况 names its main computer and
  // switches it, instead of listing per-computer copies (the older Cindy device picker).
  const homeKnown =
    cloud.enabled &&
    cloud.actors.some((actor) => actor.externalId === bot.id && !!actor.homeDeviceId);
  const openSettings = () => {
    const search = new URLSearchParams(location.search);
    search.set('settings', '1');
    navigate(`${location.pathname}?${search.toString()}`);
  };

  return (
    <div
      data-testid="bot-session-content-header"
      className="flex h-full w-full min-w-0 items-center gap-2 pr-2"
    >
      <button
        type="button"
        onClick={openSettings}
        title={bot.deviceName || t('bots.settings')}
        className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <BotAvatar bot={bot} size="xs" />
        <span className="min-w-0 truncate">{bot.name}</span>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {bot.canonicalChat && !bot.deviceId ? <BotAddToGroupMenu botId={bot.id} /> : null}
        {bot.sessionId ? <BotGlanceButton bot={bot} cloudHome={homeKnown} /> : null}
        <button
          type="button"
          onClick={openSettings}
          aria-label={t('bots.settings')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * Registration wrapper — same contract as `SessionContentHeaderRegistration`:
 * mounting registers, unmounting clears, and only the route-owning chat instance
 * renders it.
 */
export function BotSessionContentHeaderRegistration(props: { bot: BotChatIdentity }) {
  const { bot } = props;
  useRegisterContentHeader(useMemo(() => <BotSessionContentHeader bot={bot} />, [bot]));
  return null;
}
