import { app } from 'electron';

import { getReadyBinaryPath, updateReadyPiBinary } from '../agent-binaries/index.js';
import { piBinaryUpdateFailureStage } from '../agent-binaries/pi-self-update.js';
import { createPiPackageStore } from './piPackageStoreCore.js';
export type { PiPackagesChangeOrigin, PiManagedPackageSkill, PiManagedPackageResources, PiPackageSnapshotLimits, PiPackageRuntimeInvalidationPhase, PiPackageMutationHooks } from './piPackageStoreCore.js';
export { piPackageMutationFailureCategory } from './pi-package-diagnostic.js';

/**
 * Cindy-owned Pi package store: the desktop's bindings for the store shared with the Node Host
 * (piPackageStoreCore.ts). One instance per process, built at load; the exports forward to it.
 */
const piPackageStore = createPiPackageStore({
  getUserDataDir: () => app.getPath('userData'),
  getReadyBinaryPath: (kind) => getReadyBinaryPath(kind),
  updateReadyPiBinary: (force) => updateReadyPiBinary(force),
  piBinaryUpdateFailureStage: (error) => piBinaryUpdateFailureStage(error),
});
type PiPackageStore = typeof piPackageStore;

export function onPiPackagesChanged(
  ...args: Parameters<PiPackageStore['onPiPackagesChanged']>
): ReturnType<PiPackageStore['onPiPackagesChanged']> {
  return piPackageStore.onPiPackagesChanged(...args);
}

export async function runPiPackageCommand(
  ...args: Parameters<PiPackageStore['runPiPackageCommand']>
): ReturnType<PiPackageStore['runPiPackageCommand']> {
  return piPackageStore.runPiPackageCommand(...args);
}

export function piNativeManagementFailure(
  ...args: Parameters<PiPackageStore['piNativeManagementFailure']>
): ReturnType<PiPackageStore['piNativeManagementFailure']> {
  return piPackageStore.piNativeManagementFailure(...args);
}

export async function executePiNativeManagementCommand(
  ...args: Parameters<PiPackageStore['executePiNativeManagementCommand']>
): ReturnType<PiPackageStore['executePiNativeManagementCommand']> {
  return piPackageStore.executePiNativeManagementCommand(...args);
}

export function parsePiPackageListOutput(
  ...args: Parameters<PiPackageStore['parsePiPackageListOutput']>
): ReturnType<PiPackageStore['parsePiPackageListOutput']> {
  return piPackageStore.parsePiPackageListOutput(...args);
}

export async function listPiPackages(
  ...args: Parameters<PiPackageStore['listPiPackages']>
): ReturnType<PiPackageStore['listPiPackages']> {
  return piPackageStore.listPiPackages(...args);
}

export async function resolveManagedPiNativePackagePaths(
  ...args: Parameters<PiPackageStore['resolveManagedPiNativePackagePaths']>
): ReturnType<PiPackageStore['resolveManagedPiNativePackagePaths']> {
  return piPackageStore.resolveManagedPiNativePackagePaths(...args);
}

export async function resolveManagedPiPackageResources(
  ...args: Parameters<PiPackageStore['resolveManagedPiPackageResources']>
): ReturnType<PiPackageStore['resolveManagedPiPackageResources']> {
  return piPackageStore.resolveManagedPiPackageResources(...args);
}

export async function listManagedPiPromptCommands(
  ...args: Parameters<PiPackageStore['listManagedPiPromptCommands']>
): ReturnType<PiPackageStore['listManagedPiPromptCommands']> {
  return piPackageStore.listManagedPiPromptCommands(...args);
}

export function findAffectedPiPackage(
  ...args: Parameters<PiPackageStore['findAffectedPiPackage']>
): ReturnType<PiPackageStore['findAffectedPiPackage']> {
  return piPackageStore.findAffectedPiPackage(...args);
}

export const __testing = piPackageStore.__testing;

export async function stageManagedPackageSnapshot(
  ...args: Parameters<PiPackageStore['stageManagedPackageSnapshot']>
): ReturnType<PiPackageStore['stageManagedPackageSnapshot']> {
  return piPackageStore.stageManagedPackageSnapshot(...args);
}

export function piPackageMutationMayHaveChangedState(
  ...args: Parameters<PiPackageStore['piPackageMutationMayHaveChangedState']>
): ReturnType<PiPackageStore['piPackageMutationMayHaveChangedState']> {
  return piPackageStore.piPackageMutationMayHaveChangedState(...args);
}

export async function mutatePiPackage(
  ...args: Parameters<PiPackageStore['mutatePiPackage']>
): ReturnType<PiPackageStore['mutatePiPackage']> {
  return piPackageStore.mutatePiPackage(...args);
}
