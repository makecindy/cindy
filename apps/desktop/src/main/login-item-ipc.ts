import { app, ipcMain } from 'electron';

import { LOGIN_ITEM_GET_CHANNEL, LOGIN_ITEM_SET_CHANNEL } from '../shared/loginItem.js';
import { createLoginItemSettings } from './login-item-settings.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';

/** Local app-content IPC only: system-wide settings are not device-link capabilities. */
export function registerLoginItemIpc(): void {
  const settings = createLoginItemSettings({
    app,
    platform: process.platform,
    execPath: process.execPath,
  });
  ipcMain.handle(LOGIN_ITEM_GET_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return settings.read();
  });
  ipcMain.handle(LOGIN_ITEM_SET_CHANNEL, (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    return settings.set(enabled);
  });
}
