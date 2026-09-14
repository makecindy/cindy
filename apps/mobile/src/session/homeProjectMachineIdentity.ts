import type { MobileHomePresentation } from './mobileHome';

export interface HomeProjectMachineIdentity {
  displayLabel: string;
  disconnected: boolean;
  hideLabel: boolean;
}

/** Mirrors Desktop remoteProjectIdentity: only visible, distinct devices disambiguate names. */
export function buildHomeProjectMachineIdentities(
  home: Pick<MobileHomePresentation, 'projects' | 'deviceFilters' | 'selectedDeviceId'>,
  connectionStates: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, HomeProjectMachineIdentity> {
  const filters = new Map(home.deviceFilters.map((device) => [device.deviceId, device]));
  const deviceName = (project: MobileHomePresentation['projects'][number]) =>
    (filters.get(project.deviceId)?.label ?? project.deviceName).trim();
  const idsByName = new Map<string, Set<string>>();
  for (const project of home.projects) {
    const name = deviceName(project).toLowerCase();
    if (!project.deviceId || !name) continue;
    const ids = idsByName.get(name) ?? new Set<string>();
    ids.add(project.deviceId);
    idsByName.set(name, ids);
  }
  const identities = new Map<string, HomeProjectMachineIdentity>();
  for (const project of home.projects) {
    if (!project.deviceId) continue;
    const name = deviceName(project);
    const ambiguous = name && (idsByName.get(name.toLowerCase())?.size ?? 0) > 1;
    const device = filters.get(project.deviceId);
    identities.set(project.key, {
      displayLabel: ambiguous ? `${name} · ${project.deviceId}` : name || project.deviceId,
      disconnected: !device?.available || connectionStates[project.deviceId] === 'failed',
      // As on Desktop, an explicit device heading makes the inline label redundant.
      hideLabel: home.selectedDeviceId === project.deviceId,
    });
  }
  return identities;
}
