/**
 * Which installed plugins the active owner may use, shared by Desktop and the
 * Node Host. Moved verbatim from cindy-brain/index.ts; the manager and the owner
 * scope arrive as parameters. The availability check keeps its own manager read
 * (it peeks at an existing manager, managerSingleton?.); the lookups take the
 * constructing read (getGhostManager()) and the other functions as given.
 */

import { getAppCapabilities } from '../appCapabilities.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { ghostRequiresCindyAccount, type InstalledGhost } from '../../shared/ghost.js';
import {
  findInstalledGhostByInstanceId,
  installedGhostStoragePart,
  parsePluginInstallRelId,
  parsePluginStoragePart,
  resolvePluginInstanceQuery,
} from '../../shared/pluginIdentity.js';
import type { GhostOwnerScope } from './ghostOwnerScope.js';

/** The GhostManager reads these checks use. */
export interface GhostAvailabilityManager {
  findInstalledInstance(id: string): InstalledGhost | null | undefined;
  list(): InstalledGhost[];
  listAsync(): Promise<InstalledGhost[]>;
}

/** The three reads findGhostForInstanceId makes (Desktop: its own index.ts functions). */
export interface GhostInstanceLookup {
  getGhostManager(): Pick<GhostAvailabilityManager, 'findInstalledInstance'>;
  isGhostAvailableForActiveSession(id: string): boolean;
  availableGhosts(): InstalledGhost[];
}

/** Account-managed built-ins are unavailable outside a verified cloud session. */
export function isGhostAvailableForSessionIn(managerSingleton: GhostAvailabilityManager | null | undefined, id: string): boolean {
  if (isAppSessionBoundaryPending()) return false;
  const identity = parsePluginStoragePart(id) ?? parsePluginInstallRelId(id);
  const ghostId = identity?.ghostId ?? id;
  if (getAppCapabilities().canUseCindyAccountServices) return true;
  const exact = managerSingleton?.findInstalledInstance(id);
  if (exact) return !ghostRequiresCindyAccount(exact.manifest);
  const ghosts = managerSingleton?.list() ?? [];
  const target = findInstalledGhostByInstanceId(ghosts, id);
  return target ? !ghostRequiresCindyAccount(target.manifest)
    : !ghosts.some(ghost => ghost.manifest.id === ghostId && ghostRequiresCindyAccount(ghost.manifest));
}

export function availableGhostsIn(getGhostManager: () => GhostAvailabilityManager): InstalledGhost[] {
  if (isAppSessionBoundaryPending()) return [];
  const accountServices = getAppCapabilities().canUseCindyAccountServices;
  return getGhostManager().list()
    .filter(ghost => accountServices || !ghostRequiresCindyAccount(ghost.manifest));
}

export function findGhostForInstanceIdIn(
  lookup: GhostInstanceLookup,
  id: string,
  namespace?: string | null,
): InstalledGhost | null {
  // Plugin requests recheck their target many times per call. An exact
  // instance key reads only that instance so each check does not rescan every
  // install; anything else still resolves against the full list.
  if (namespace === undefined) {
    if (isAppSessionBoundaryPending()) return null;
    const ghost = lookup.getGhostManager().findInstalledInstance(id);
    if (ghost) return lookup.isGhostAvailableForActiveSession(installedGhostStoragePart(ghost)) ? ghost : null;
  }
  const resolved = resolvePluginInstanceQuery(lookup.availableGhosts(), id, namespace);
  return resolved.status === 'unique' ? resolved.ghost : null;
}

/** Discovery may yield, but never carries an old owner's results into a new account. */
export async function listInstalledGhostsForOwner(
  ghostOwnerScope: Pick<GhostOwnerScope, 'capture' | 'isCurrent' | 'isStable'>,
  getGhostManager: () => Pick<GhostAvailabilityManager, 'listAsync'>,
): Promise<InstalledGhost[]> {
  const owner = ghostOwnerScope.capture();
  if (!ghostOwnerScope.isCurrent(owner) || !ghostOwnerScope.isStable(owner)) return [];
  const ghosts = await getGhostManager().listAsync();
  if (!ghostOwnerScope.isCurrent(owner) || !ghostOwnerScope.isStable(owner)) return [];
  return ghosts;
}

export async function listAvailableGhostsFrom(
  listInstalledGhostsAsync: () => Promise<InstalledGhost[]>,
): Promise<InstalledGhost[]> {
  const ghosts = await listInstalledGhostsAsync();
  if (isAppSessionBoundaryPending()) return [];
  // The scan already supplies each exact instance. Looking up its bare id again
  // can fall back to N full scans (and confuse same-name namespace instances).
  const accountServices = getAppCapabilities().canUseCindyAccountServices;
  return ghosts.filter(ghost => accountServices || !ghostRequiresCindyAccount(ghost.manifest));
}
