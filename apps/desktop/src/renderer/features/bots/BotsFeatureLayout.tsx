import { useContext, useEffect } from 'react';
import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { Outlet, useOutletContext, useParams, useLocation } from 'react-router-dom';

import { useOwnTopNavScrollableRows } from '../feature-context';
import { useRemoteBotSync } from './useRemoteBots';
import { BotsSidebar } from './BotsSidebar';
import { BotSettingsDrawer } from './BotSettingsDrawer';
import { BotGroupSettingsDrawer } from './BotGroupSettingsDrawer';
import { startBotGroupSync } from './botGroupStore';
import { refreshBotProfiles, useBotProfiles } from './botStore';

export function BotsFeatureLayout() {
  useOwnTopNavScrollableRows(false);
  useRemoteBotSync();
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
  useEffect(() => {
    refreshBotProfiles();
    const unsubscribeProfile = window.electronAPI.maker.onBotProfileChanged(() =>
      refreshBotProfiles(),
    );
    const unsubscribeLifecycle = window.electronAPI.maker.onBotLifecycleChanged(() =>
      refreshBotProfiles(),
    );
    return () => {
      unsubscribeProfile();
      unsubscribeLifecycle();
    };
  }, []);
  // 群聊列表(侧栏分组与群设置共用)跟随 main 的 onBotGroupChanged 推送刷新。
  useEffect(() => startBotGroupSync(), []);
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
