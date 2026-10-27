import { parsePluginInstallRelId, pluginInstallStoragePart } from './pluginIdentity.js';

export const LEGACY_SIMULATOR_ID = 'baguette-simulator';
export const SIMULATOR_ID = 'cindy-simulator';

/** One host-owned migration; never an author-controlled alias or organization takeover. */
export function isSimulatorMigrationTarget(value: {
  ghostId: string; namespace?: string | null; scope?: string;
}): boolean {
  return value.ghostId === SIMULATOR_ID && value.namespace == null && value.scope === 'public';
}

export function isLegacySimulatorListing(value: { ghostId: string; namespace?: string | null; scope?: string }): boolean {
  return value.ghostId === LEGACY_SIMULATOR_ID && value.namespace == null && value.scope === 'public';
}

export function simulatorPreviousStoragePart(previousRelId: unknown): string | null {
  if (typeof previousRelId !== 'string') return null;
  const identity = parsePluginInstallRelId(previousRelId);
  return identity?.ghostId === LEGACY_SIMULATOR_ID && identity.namespace === null
    ? pluginInstallStoragePart(previousRelId) : null;
}

export function validSimulatorMigration(previousRelId: unknown, ghostId: string, namespace: unknown): boolean {
  return ghostId === SIMULATOR_ID && namespace === null && simulatorPreviousStoragePart(previousRelId) !== null;
}
