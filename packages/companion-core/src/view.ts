/** Renderer view of companion homes: the registry plus device-link names and presence. */
import type { CompanionCloudSnapshot } from './contract.js';
import type { DeviceLinkDeviceView } from './device.js';

export async function companionCloudView(
  snapshot: CompanionCloudSnapshot,
  listDevices: () => Promise<DeviceLinkDeviceView[]>,
): Promise<CompanionCloudSnapshot> {
  if (!snapshot.enabled) return snapshot;
  // Presence is advisory; without the list the homes still show, just not their names.
  const devices = await listDevices().catch(() => [] as DeviceLinkDeviceView[]);
  return {
    ...snapshot,
    actors: snapshot.actors.map(actor => {
      if (!actor.homeDeviceId) return { ...actor, homeDevice: null };
      const isSelf = actor.homeDeviceId === snapshot.selfDeviceId;
      const device = devices.find(candidate => candidate.deviceId === actor.homeDeviceId);
      return { ...actor, homeDevice: { deviceId: actor.homeDeviceId, name: device?.name ?? '', online: isSelf || device?.online === true, isSelf } };
    }),
  };
}
