import { useAuth } from '@/contexts/AuthContext';
import { useBotUnreadSync } from '@/features/bots/useBotUnreadSync';
import { useRemoteBotSync } from '@/features/bots/useRemoteBots';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { AppBadgeAttentionSync } from './AppBadgeAttentionSync';

/** Each full app renderer owns its data mirrors; only the main window publishes attention. */
export function AppWindowSync() {
  useAuth();
  useBotUnreadSync();
  useRemoteBotSync();
  return isSecondaryWindow() ? null : <AppBadgeAttentionSync />;
}
