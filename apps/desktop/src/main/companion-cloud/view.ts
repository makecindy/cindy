/** Renderer view of companion homes: the registry plus device-link names and presence. */
import type { CompanionArrivalNoticeKind, CompanionCloudSnapshot } from '../../shared/companionCloud.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';

export async function companionCloudView(
  snapshot: CompanionCloudSnapshot,
  listDevices: () => Promise<DeviceLinkDeviceView[]>,
  arrivalNotices: (botId: string) => CompanionArrivalNoticeKind[] = () => [],
): Promise<CompanionCloudSnapshot> {
  if (!snapshot.enabled) return snapshot;
  // Presence is advisory; without the list the homes still show, just not their names.
  const devices = await listDevices().catch(() => [] as DeviceLinkDeviceView[]);
  return {
    ...snapshot,
    actors: snapshot.actors.map(actor => {
      const notices = arrivalNotices(actor.externalId);
      if (notices.length) actor = { ...actor, arrivalNotices: notices };
      if (!actor.homeDeviceId) return { ...actor, homeDevice: null };
      const isSelf = actor.homeDeviceId === snapshot.selfDeviceId;
      const device = devices.find(candidate => candidate.deviceId === actor.homeDeviceId);
      return { ...actor, homeDevice: { deviceId: actor.homeDeviceId, name: device?.name ?? '', online: isSelf || device?.online === true,
        ...(device ? { remoteControlEnabled: device.remoteControlEnabled } : {}), isSelf } };
    }),
  };
}
