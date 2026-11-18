import { app, BrowserWindow, ipcMain } from 'electron';
import {
  configureSidebarSettingsPlatform,
  claimLegacyRendererSidebarOwner,
  loadSidebarSettingsSnapshot,
  savePinnedOrder,
  setProjectHidden,
  setMainViewHidden,
} from './sidebarSettingsStoreCore.js';
import {
  hasExclusiveSharedLegacyUserDataAccess,
  isLegacyOwnerNamespaceClaimOwnedBy,
  isLegacyOwnerNamespaceClaimedByOtherOwner,
} from './ownerNamespaceMigration.js';
import { resumeInputDeviceTaskSlots } from './input-devices/registry.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from './security/trustedAppRenderer.js';
import { isAppContentWindow } from './windowFocusClassifier.js';
import type {
  SidebarPinnedOrderWriteRequest,
  SidebarProjectHiddenWriteRequest,
  SidebarMainViewHiddenWriteRequest,
} from '../shared/sidebarSettings.js';
export {
  loadSidebarSettingsSnapshot,
  restoreLocalProjectVisibility,
  setLocalProjectHidden,
  setLocalMainViewHidden,
  __testing,
} from './sidebarSettingsStoreCore.js';

configureSidebarSettingsPlatform({
  legacyRoot: () => app.getPath('userData'),
  hasExclusiveSharedLegacyUserDataAccess: () => hasExclusiveSharedLegacyUserDataAccess(),
  isLegacyOwnerNamespaceClaimOwnedBy: (owner) => isLegacyOwnerNamespaceClaimOwnedBy(owner),
  isLegacyOwnerNamespaceClaimedByOtherOwner: (owner) =>
    isLegacyOwnerNamespaceClaimedByOtherOwner(owner),
  refreshInputDeviceTaskSlots: () => resumeInputDeviceTaskSlots(),
  broadcast: (channel, value, owner, target) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!(target === 'trusted' ? isTrustedAppRendererWindow(window) : isAppContentWindow(window)))
        continue;
      window.webContents.send(channel, Array.from(value), owner);
    }
  },
});

export function registerSidebarSettingsIpc(): void {
  ipcMain.on('sidebar-settings:claim-renderer-legacy-owner-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = claimLegacyRendererSidebarOwner();
  });
  ipcMain.on('sidebar-settings:load-snapshot-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = loadSidebarSettingsSnapshot();
  });
  ipcMain.handle('sidebar-settings:save-pinned-order', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return savePinnedOrder(request as SidebarPinnedOrderWriteRequest);
  });
  ipcMain.handle('sidebar-settings:set-project-hidden', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return setProjectHidden(request as SidebarProjectHiddenWriteRequest);
  });
  ipcMain.handle('sidebar-settings:set-main-view-hidden', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return setMainViewHidden(request as SidebarMainViewHiddenWriteRequest);
  });
}
