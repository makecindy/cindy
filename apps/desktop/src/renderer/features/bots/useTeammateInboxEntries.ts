import { useMemo } from 'react';

import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useOfflineInboxIntentsRevision } from '@/features/device-link/offlineInboxIntentsStore';
import { useBotProfiles, useBotUnreadCounts } from './botStore';
import { cloudRemoteBots, withoutShadowedBots } from './companionCloudPresentation';
import { useCompanionCloud } from './companionCloudStore';
import { teammateInboxEntries, type TeammateInboxEntry } from './teammateInbox';
import { useRemoteBots } from './useRemoteBots';

/** Reads the stores the teammate section already keeps in sync; issues no request of its own. */
export function useTeammateInboxEntries(): TeammateInboxEntry[] {
  const cloud = useCompanionCloud();
  const rosterRemoteBots = useRemoteBots();
  const allBots = useBotProfiles();
  const unreadByBotId = useBotUnreadCounts();
  const activities = useAgentIslandActivityMap();
  const devices = useDeviceLinkDeviceList();
  const offlineInboxRevision = useOfflineInboxIntentsRevision();
  return useMemo(() => {
    const remoteBots = cloudRemoteBots(cloud, rosterRemoteBots);
    const self = devices?.find((device) => device.isSelf);
    return teammateInboxEntries({
      bots: withoutShadowedBots(allBots, cloud),
      remoteBots,
      activities,
      unreadByBotId,
      devices: [...(self ? [self] : []), ...remoteBots.map((bot) => ({ deviceId: bot.deviceId, name: bot.deviceName }))],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- offlineInboxRevision triggers re-projection when offline snooze intents change
  }, [cloud, rosterRemoteBots, allBots, unreadByBotId, activities, devices, offlineInboxRevision]);
}
