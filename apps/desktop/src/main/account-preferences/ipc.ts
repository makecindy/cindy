/** Local renderer access to the account's explicit, synchronized UI preferences. */
import { BrowserWindow, ipcMain } from 'electron';

import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  importLegacyAccountPreferences,
  loadAccountPreferencesSnapshot,
  onAccountPreferencesChanged,
  setAccountPreference,
} from './store.js';

const log = createLogger('account-preferences:ipc');

export function registerAccountPreferencesIpc(): void {
  ipcMain.handle('account-preferences:load', (event) => {
    assertTrustedAppRendererEvent(event);
    return loadAccountPreferencesSnapshot();
  });
  ipcMain.handle('account-preferences:set', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return setAccountPreference(request);
  });
  ipcMain.handle('account-preferences:import-legacy', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return importLegacyAccountPreferences(request);
  });

  onAccountPreferencesChanged(({ snapshot }) => {
    const current = getActiveDataOwnerPushStamp();
    if (!isDataOwnerPushStamp(current)
      || current.dataOwnerId !== snapshot.dataOwnerId
      || current.ownerGeneration !== snapshot.ownerGeneration) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !isTrustedAppRendererWindow(win)) continue;
      try {
        win.webContents.send('account-preferences:changed', snapshot);
      } catch {
        // A window closing during a broadcast cannot undo the already durable preference.
        log.warn('preference update could not reach a closing window');
      }
    }
  });
}
