import { ipcMain } from 'electron';

import { MENUBAR_GET_STATE_CHANNEL, MENUBAR_SET_ENABLED_CHANNEL } from '../../shared/menubarQuota.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireBoolean } from '../utils/ipcValidate.js';
import { getMenubarState, setMenubarEnabled } from './service.js';

/** Settings → Window behavior toggle. Local app renderer only; not a device-link capability. */
export function registerMenubarIpc(): void {
  ipcMain.handle(MENUBAR_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return getMenubarState();
  });
  ipcMain.handle(MENUBAR_SET_ENABLED_CHANNEL, (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    return setMenubarEnabled(requireBoolean(enabled, 'enabled'));
  });
}
