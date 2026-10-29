import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { resolveRemoteText } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { cachedTaskFollowers, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { iconSize } from '@/theme/tokens';

/**
 * Teammates looking after this task: tasks they started or explicitly took over
 * (cindy-bots-runtime.md, desktop `useSessionFollowers`). Read from the teammate roster's
 * `following` links, so archived tasks and other computers' rosters never mark it.
 */
export function useTaskFollowers(session: { id: string; status: string; deviceLinkDeviceId?: string | null }) {
  const userId = useAuth().user?.id ?? '';
  const deviceId = session.status === 'active' ? session.deviceLinkDeviceId ?? '' : '';
  const read = () => cachedTaskFollowers(userId, deviceId, session.id);
  return useSyncExternalStore(subscribeRemoteResourceCache, read, read);
}

/** Names for the row's spoken label, in the order the mark is chosen. */
export function taskFollowerNames(followers: readonly HostedRemoteCollectionItem[], language: string): string {
  const separator = /^(zh|ja)/.test(language) ? '、' : ', ';
  return followers.map((row) => resolveRemoteText(row.item.display.title, language)).join(separator);
}

/** The first teammate's 16pt avatar beside the task title; its identity, not a status. */
export function TaskFollowMark({ follower, testID }: { follower: HostedRemoteCollectionItem; testID: string }) {
  const { status, getPresenceAvailability } = useDeviceLink();
  const { host, item } = follower;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" testID={testID}>
      <RemoteCompanionAvatar
        avatar={item.display.avatar}
        deviceId={host.deviceId}
        framed
        name={resolveRemoteText(item.display.title)}
        online={status === 'online' && getPresenceAvailability(host.deviceId) !== false}
        size={iconSize.md}
      />
    </View>
  );
}

/** Creation/ownership persists when the task is archived or no longer followed. */
export function TaskCreatorMark({ teammate, deviceId, testID }: {
  teammate: import('./teammateTaskSource').TaskTeammate; deviceId: string; testID: string;
}) {
  const { status, getPresenceAvailability } = useDeviceLink();
  return <View accessible={false} importantForAccessibility="no-hide-descendants" testID={testID}>
    <RemoteCompanionAvatar avatar={teammate.avatar} deviceId={deviceId} name={teammate.name}
      framed size={iconSize.md} online={status === 'online' && getPresenceAvailability(deviceId) !== false} />
  </View>;
}
