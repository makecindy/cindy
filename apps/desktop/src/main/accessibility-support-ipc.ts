import { app, BrowserWindow, ipcMain } from 'electron';
import { ACCESSIBILITY_SUPPORT_CHANGED, ACCESSIBILITY_SUPPORT_GET } from '../shared/accessibilitySupport.js';
import { isTrustedAppRendererEvent, isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

let registered = false;

/** Register before creating chat windows so preload can expose the initial state. */
export function registerAccessibilitySupportIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(ACCESSIBILITY_SUPPORT_GET, event => {
    event.returnValue = isTrustedAppRendererEvent(event) ? app.accessibilitySupportEnabled : null;
  });
  app.on('accessibility-support-changed', (_event, enabled) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (isTrustedAppRendererWindow(win)) win.webContents.send(ACCESSIBILITY_SUPPORT_CHANGED, enabled);
    }
  });
}
