import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { startBotGroupOutbox } from '@/features/bots/botGroupOutbox';
import { useBotUnreadSync } from '@/features/bots/useBotUnreadSync';
import { useRemoteBotSync } from '@/features/bots/useRemoteBots';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { AppBadgeAttentionSync } from './AppBadgeAttentionSync';

const ActivateOutboxContext = createContext<(() => void) | null>(null);

/** Start after the full app is ready, then survive sibling routes for this owner. */
export function AppOutboxProvider({ children }: PropsWithChildren) {
  const { canEnterApp, isInitializing } = useAuth();
  const owner = getDataOwnerGeneration();
  const [active, setActive] = useState(false);
  const activate = useCallback(() => setActive(true), []);
  useEffect(() => {
    if (!active || !canEnterApp || isInitializing || !owner.dataOwnerId) return;
    return startBotGroupOutbox({ restoreSavedEntries: !isSecondaryWindow() });
  }, [active, canEnterApp, isInitializing, owner]);
  return <ActivateOutboxContext.Provider value={activate}>{children}</ActivateOutboxContext.Provider>;
}

/** Each full app renderer owns its data mirrors; only the main window publishes attention. */
export function AppWindowSync() {
  useAuth();
  useBotUnreadSync();
  useRemoteBotSync();
  const activateOutbox = useContext(ActivateOutboxContext);
  useEffect(() => { activateOutbox?.(); }, [activateOutbox]);
  return isSecondaryWindow() ? null : <AppBadgeAttentionSync />;
}
