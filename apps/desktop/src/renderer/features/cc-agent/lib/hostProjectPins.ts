import type { HostProjectPinsSnapshot } from '@cindy/maker-shared/project-pin-sync';

import { deviceLinkProjectKey, normalizeProjectKey } from '../../../../shared/projectKeys';
import { isWindowsPathLike } from '../../../../shared/workingDir';
import { projectKeyFromPinnedEntryId } from './pinnedSidebarOrder';

/**
 * Project pins follow the desktop that owns the project, like task pins.
 *
 * - This computer's own and SSH projects: the local pinned list is the truth.
 * - Another desktop's project, once that desktop owns its pins ("pin host"): the host
 *   snapshot is the truth and local `project:device:<id>:` entries only rank them here.
 *   While the host is unreachable those entries stand in for its last known pins.
 * - Another desktop that has not taken over yet (older version, or never reached):
 *   local entries stay real pins and are handed to the host once it can accept them.
 */

export interface HostProjectPinTarget {
  deviceId: string;
  /** The same project as the owning desktop's `local:` identity. */
  hostKey: string;
}

/** Splits this computer's `device:<id>:<path>` key into the owning desktop and its local key. */
export function hostProjectPinTarget(projectKey: string): HostProjectPinTarget | null {
  const normalized = normalizeProjectKey(projectKey);
  if (!normalized?.startsWith('device:')) return null;
  const rest = normalized.slice('device:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(rest.slice(0, separator));
  } catch {
    return null;
  }
  const workingDir = rest.slice(separator + 1);
  return deviceId && workingDir ? { deviceId, hostKey: `local:${workingDir}` } : null;
}

/** The owning desktop's `local:` key as this computer's sidebar identity for that project. */
export function controllerProjectKeyForHostPin(deviceId: string, hostKey: string): string | null {
  const normalized = normalizeProjectKey(hostKey);
  if (!normalized?.startsWith('local:')) return null;
  return deviceLinkProjectKey(deviceId, normalized.slice('local:'.length));
}

/**
 * Comparison identity for pins. A Windows host matches its drive and UNC paths without case,
 * so its pinned spelling may differ from the session spelling this sidebar groups by.
 */
export function projectPinIdentity(projectKey: string): string {
  const normalized = normalizeProjectKey(projectKey) ?? projectKey;
  const target = hostProjectPinTarget(normalized);
  if (!target) return normalized;
  const workingDir = target.hostKey.slice('local:'.length);
  return isWindowsPathLike(workingDir)
    ? deviceLinkProjectKey(target.deviceId, workingDir.toLowerCase())
    : normalized;
}

function hostDecides(
  deviceId: string,
  hostPins: ReadonlyMap<string, HostProjectPinsSnapshot>,
  pinHostDeviceIds: ReadonlySet<string>,
): boolean {
  return pinHostDeviceIds.has(deviceId) && hostPins.get(deviceId)?.available === true;
}

/**
 * Every project this computer should show as pinned, spelled like the sidebar's own
 * project keys (`knownProjectKeys`) whenever the identity matches one of them.
 */
export function resolvePinnedProjectKeys(input: {
  manualPinnedOrder: readonly string[];
  hostPins: ReadonlyMap<string, HostProjectPinsSnapshot>;
  pinHostDeviceIds: ReadonlySet<string>;
  knownProjectKeys?: readonly string[];
}): Set<string> {
  const knownByIdentity = new Map<string, string>();
  for (const projectKey of input.knownProjectKeys ?? []) {
    const identity = projectPinIdentity(projectKey);
    if (!knownByIdentity.has(identity)) knownByIdentity.set(identity, projectKey);
  }
  const displayed = (projectKey: string) =>
    knownByIdentity.get(projectPinIdentity(projectKey)) ?? projectKey;

  const keys = new Set<string>();
  for (const entryId of input.manualPinnedOrder) {
    const projectKey = projectKeyFromPinnedEntryId(entryId);
    if (!projectKey) continue;
    const target = hostProjectPinTarget(projectKey);
    if (target && hostDecides(target.deviceId, input.hostPins, input.pinHostDeviceIds)) continue;
    keys.add(displayed(projectKey));
  }
  for (const [deviceId, snapshot] of input.hostPins) {
    if (!snapshot.available) continue;
    for (const hostKey of snapshot.projectKeys) {
      const projectKey = controllerProjectKeyForHostPin(deviceId, hostKey);
      if (projectKey) keys.add(displayed(projectKey));
    }
  }
  return keys;
}

function localEntriesForDevice(
  manualPinnedOrder: readonly string[],
  deviceId: string,
): { entryId: string; hostKey: string; identity: string }[] {
  const entries: { entryId: string; hostKey: string; identity: string }[] = [];
  for (const entryId of manualPinnedOrder) {
    const projectKey = projectKeyFromPinnedEntryId(entryId);
    const target = projectKey ? hostProjectPinTarget(projectKey) : null;
    if (!projectKey || target?.deviceId !== deviceId) continue;
    entries.push({ entryId, hostKey: target.hostKey, identity: projectPinIdentity(projectKey) });
  }
  return entries;
}

function hostPinnedIdentities(deviceId: string, snapshot: HostProjectPinsSnapshot): Set<string> {
  const identities = new Set<string>();
  for (const hostKey of snapshot.projectKeys) {
    const projectKey = controllerProjectKeyForHostPin(deviceId, hostKey);
    if (projectKey) identities.add(projectPinIdentity(projectKey));
  }
  return identities;
}

/** Local pins this computer made before the host took over, in host-local keys. */
export function legacyProjectPinsForHost(
  manualPinnedOrder: readonly string[],
  deviceId: string,
  snapshot: HostProjectPinsSnapshot,
): string[] {
  const pinned = hostPinnedIdentities(deviceId, snapshot);
  const handed = new Set<string>();
  const keys: string[] = [];
  for (const { hostKey, identity } of localEntriesForDevice(manualPinnedOrder, deviceId)) {
    if (pinned.has(identity) || handed.has(identity)) continue;
    handed.add(identity);
    keys.push(hostKey);
  }
  return keys;
}

/** Ranking entries for projects the host no longer pins; pruning keeps the offline fallback honest. */
export function staleProjectPinHints(
  manualPinnedOrder: readonly string[],
  deviceId: string,
  snapshot: HostProjectPinsSnapshot,
): string[] {
  const pinned = hostPinnedIdentities(deviceId, snapshot);
  return localEntriesForDevice(manualPinnedOrder, deviceId)
    .filter(({ identity }) => !pinned.has(identity))
    .map(({ entryId }) => entryId);
}
