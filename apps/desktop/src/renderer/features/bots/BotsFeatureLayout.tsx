import { useContext, useEffect } from 'react';
import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { Outlet, useOutletContext, useParams, useLocation } from 'react-router-dom';

import { useOwnTopNavScrollableRows } from '../feature-context';
import { BotsSidebar } from './BotsSidebar';
import { BotSettingsDrawer } from './BotSettingsDrawer';
import { BotGroupSettingsDrawer } from './BotGroupSettingsDrawer';
import { useBotProfiles } from './botStore';

export function BotsFeatureLayout() {
  useOwnTopNavScrollableRows(false);
  const history = useContext(MainViewHistoryContext);
  const { botId, deviceId } = useParams();
  const location = useLocation();
  const bots = useBotProfiles();
  useEffect(() => {
    if (!history || deviceId || !botId || history.current.ignoredLocationKey === location.key) return;
    const bot = bots.find(candidate => candidate.id === botId);
    if (bot && bot.status !== 'archived' && bot.status !== 'deleting') {
      history.current.lastBotId = bot.id;
    }
  }, [history, botId, deviceId, bots, location.key]);
  const shellContext = useOutletContext<{
    sidebarWidth?: number;
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (
      sessionId: string | null,
      opts?: { initialCollapsed?: boolean; writeInitialCollapsedRecord?: boolean },
    ) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  return (
    <>
      <BotsSidebar />
      <Outlet context={shellContext} />
      <BotSettingsDrawer />
      <BotGroupSettingsDrawer />
    </>
  );
}
