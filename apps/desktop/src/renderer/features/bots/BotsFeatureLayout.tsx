import { useEffect } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';

import { useOwnTopNavScrollableRows } from '../feature-context';
import { BotsSidebar } from './BotsSidebar';
import { BotSettingsDrawer } from './BotSettingsDrawer';
import { refreshBotProfiles } from './botStore';

export function BotsFeatureLayout() {
  useOwnTopNavScrollableRows(false);
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
    </>
  );
}
