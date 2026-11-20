import { createAuxiliaryModelSettingsStore } from '../../../desktop/src/main/utility-model/auxiliaryModelSettingsStoreCore.js';
import { createAuxiliaryModelChainResolver } from '../../../desktop/src/main/utility-model/resolveAuxiliaryModelChainCore.js';

/**
 * The auxiliary-model chain the desktop resolves (auxiliary-model-settings-store.ts,
 * resolveAuxiliaryModelChain.ts), over the same owner-scoped settings file in this profile.
 *
 * Two answers differ from the desktop, both so the Host never writes or deletes that file
 * (release table, section two):
 * - The legacy-namespace checks answer false. A Host profile is not the desktop's shared
 *   pre-owner userData, so the unscoped legacy voice file is never read, and a legacy format
 *   in the owner directory is used in memory only; the window process, which shares the
 *   owner directory in client mode, stays the only writer.
 * - An unreadable settings file is kept instead of deleted. It still reads as automatic, as
 *   it does on the desktop once deleted.
 */
export function createHostAuxiliaryModelChain(options: { userDataDir: string }) {
  const settings = createAuxiliaryModelSettingsStore({
    app: { getPath: () => options.userDataDir },
    hasExclusiveSharedLegacyUserDataAccess: () => false,
    hasLegacyOwnerNamespaceClaim: () => false,
    preserveUnreadableFile: true,
  });
  const chain = createAuxiliaryModelChainResolver({
    readAuxiliaryModelSettings: () => settings.readAuxiliaryModelSettings(),
  });
  return { settings, chain };
}
