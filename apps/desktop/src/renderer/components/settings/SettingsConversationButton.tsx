import { useContext, useRef, useState } from 'react';
import { matchPath } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelsTopLeft } from 'lucide-react';

import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useRemoteBots } from '@/features/bots/useRemoteBots';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

const log = createLogger('SettingsConversationButton');

/** Reuse account-scoped navigation history; never persist a second task pointer. */
export function SettingsConversationButton() {
  const history = useContext(MainViewHistoryContext);
  const remoteBots = useRemoteBots();
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const view = history?.current.lastMatchedKey;
  const path = view === 'cc-agent' || view === 'bots' ? history?.current.paths[view] : undefined;
  const url = path ? new URL(path, 'https://cindy.invalid') : null;
  const remoteSessionMatch = url && matchPath('/bots/remote/:deviceId/:botId/session/:sessionId', url.pathname);
  const remoteBotMatch = remoteSessionMatch ?? (url && matchPath('/bots/remote/:deviceId/:botId', url.pathname));
  const botMatch = url && (
    matchPath('/bots/:botId/session/:sessionId', url.pathname) ??
    matchPath('/bots/:botId/history/:sessionId', url.pathname) ??
    remoteSessionMatch
  );
  const sessionId = url
    ? resolveAgentIslandVisibleSessionIdFromPath(url.pathname) ?? botMatch?.params.sessionId
      // Offline companion pages may display cloud history. A cached session ID
      // cannot open that history through the device-link session window.
      ?? (remoteBotMatch ? remoteBots.find((bot) =>
        bot.online && bot.deviceId === remoteBotMatch.params.deviceId && bot.id === remoteBotMatch.params.botId)?.sessionId : null)
    : null;
  // Freeze the originating device before opening another renderer. The sticky
  // resolver preserves it while a remote mirror is temporarily reconnecting.
  const deviceId = remoteBotMatch?.params.deviceId || url?.searchParams.get('device')
    || getStickySessionDeviceId(sessionId);

  if (!sessionId || !window.electronAPI?.maker?.openSessionInNewWindow) return null;

  const openConversation = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await window.electronAPI.maker.openSessionInNewWindow(sessionId, deviceId);
    } catch (error) {
      log.warn('Failed to open conversation from settings', error);
      toast.error(t('settings.conversation.openFailed'));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  return (
    <Tip text={t('settings.conversation.hint')} side="bottom" contentClassName="max-w-[min(280px,calc(100vw-24px))] break-words">
      <Button variant="secondary" compact loading={opening} onClick={() => void openConversation()} className="w-full">
        <PanelsTopLeft size={16} aria-hidden="true" className="shrink-0" />
        {t('settings.conversation.open')}
      </Button>
    </Tip>
  );
}
