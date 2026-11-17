import { deviceDisplayName } from '@/device-link/deviceName';
import type { DeviceLinkContextValue } from '@/device-link/DeviceLinkContext';
import type { MobileHomePresentation } from './mobileHome';

export interface HomeProjectMachineIdentity {
  displayLabel: string;
  disconnected: boolean;
  hideLabel: boolean;
}

type HomeProjectConnection = Pick<DeviceLinkContextValue, 'getPresenceAvailability'> & {
  unresponsiveDevices: ReadonlySet<string>;
  revokedDevices: ReadonlySet<string>;
};

/** Mirrors Desktop remoteProjectIdentity: only visible, distinct devices disambiguate names. */
export function buildHomeProjectMachineIdentities(
  home: Pick<MobileHomePresentation, 'projects' | 'deviceFilters' | 'selectedDeviceId'>,
  connection: HomeProjectConnection,
): ReadonlyMap<string, HomeProjectMachineIdentity> {
  const filters = new Map(home.deviceFilters.map((device) => [device.deviceId, device]));
  const deviceName = (project: MobileHomePresentation['projects'][number]) =>
    (filters.get(project.deviceId)?.label ?? project.deviceName).trim();
  const devices = home.projects.flatMap((project) => project.deviceId
    ? [{ deviceId: project.deviceId, name: deviceName(project) }] : []);
  const identities = new Map<string, HomeProjectMachineIdentity>();
  for (const project of home.projects) {
    if (!project.deviceId) continue;
    const name = deviceName(project);
    identities.set(project.key, {
      displayLabel: deviceDisplayName(project.deviceId, name, devices),
      // A remounted list paints cached projects before its device roster arrives.
      // Missing/stale roster rows and failed list reads are not connection evidence.
      // Neither is the phone's own relay connection: while it reconnects (every
      // return to the app) the computer is unknown, not disconnected. The
      // connection banner reports the phone's side.
      disconnected: connection.getPresenceAvailability(project.deviceId) === false
        || connection.unresponsiveDevices.has(project.deviceId)
        || connection.revokedDevices.has(project.deviceId),
      // As on Desktop, an explicit device heading makes the inline label redundant.
      hideLabel: home.selectedDeviceId === project.deviceId,
    });
  }
  return identities;
}
