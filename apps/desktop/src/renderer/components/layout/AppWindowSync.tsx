import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { startBotGroupOutbox } from '@/features/bots/botGroupOutbox';
import { useBotUnreadSync } from '@/features/bots/useBotUnreadSync';
import { useRemoteBotSync } from '@/features/bots/useRemoteBots';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { AppBadgeAttentionSync } from './AppBadgeAttentionSync';

/** Each full app renderer owns its data mirrors; only the main window publishes attention. */
export function AppWindowSync() {
  useAuth();
  useBotUnreadSync();
  useRemoteBotSync();
  const owner = getDataOwnerGeneration();
  useEffect(() => startBotGroupOutbox({ restoreSavedEntries: !isSecondaryWindow() }), [owner]);
  return isSecondaryWindow() ? null : <AppBadgeAttentionSync />;
}
