/**
 * Main-process source of truth for the shared auxiliary-model chain.
 *
 * Only an explicit `models` override is persisted. An empty list (or a missing
 * file) means “automatic”, so restoring the default deletes the file rather
 * than writing a snapshot of the current built-in chain.
 */

// The store itself lives in auxiliaryModelSettingsStoreCore.ts (shared with the Node Host).
// This module builds the single Desktop instance; its ports resolve the Desktop modules when
// called, never when this module loads.
import { createAuxiliaryModelSettingsStore } from './auxiliaryModelSettingsStoreCore.js';
import { app } from 'electron';
import { hasExclusiveSharedLegacyUserDataAccess, hasLegacyOwnerNamespaceClaim } from '../ownerNamespaceMigration.js';

const desktopStore = createAuxiliaryModelSettingsStore({
  app: { getPath: (name) => app.getPath(name) },
  hasExclusiveSharedLegacyUserDataAccess: (...args) => hasExclusiveSharedLegacyUserDataAccess(...args),
  hasLegacyOwnerNamespaceClaim: (...args) => hasLegacyOwnerNamespaceClaim(...args),
});
type Instance = typeof desktopStore;

export const __testing = desktopStore.__testing;

export const auxiliaryModelPortableSettings = desktopStore.auxiliaryModelPortableSettings;

export function migrateLegacyAuxiliaryModelSettings(...args: Parameters<Instance['migrateLegacyAuxiliaryModelSettings']>): ReturnType<Instance['migrateLegacyAuxiliaryModelSettings']> {
  return desktopStore.migrateLegacyAuxiliaryModelSettings(...args);
}

export function readAuxiliaryModelSettings(...args: Parameters<Instance['readAuxiliaryModelSettings']>): ReturnType<Instance['readAuxiliaryModelSettings']> {
  return desktopStore.readAuxiliaryModelSettings(...args);
}

export function readAuxiliaryModelSettingsState(...args: Parameters<Instance['readAuxiliaryModelSettingsState']>): ReturnType<Instance['readAuxiliaryModelSettingsState']> {
  return desktopStore.readAuxiliaryModelSettingsState(...args);
}

export function isAuxiliaryModelCustomized(...args: Parameters<Instance['isAuxiliaryModelCustomized']>): ReturnType<Instance['isAuxiliaryModelCustomized']> {
  return desktopStore.isAuxiliaryModelCustomized(...args);
}

export function writeAuxiliaryModelSettingsPatch(...args: Parameters<Instance['writeAuxiliaryModelSettingsPatch']>): ReturnType<Instance['writeAuxiliaryModelSettingsPatch']> {
  return desktopStore.writeAuxiliaryModelSettingsPatch(...args);
}

export function resetAuxiliaryModelSettings(...args: Parameters<Instance['resetAuxiliaryModelSettings']>): ReturnType<Instance['resetAuxiliaryModelSettings']> {
  return desktopStore.resetAuxiliaryModelSettings(...args);
}
