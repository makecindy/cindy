import { ipcMain } from 'electron';

import { MENUBAR_GET_STATE_CHANNEL, MENUBAR_SET_ENABLED_CHANNEL } from '../../shared/menubarQuota.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireBoolean } from '../utils/ipcValidate.js';
import { getMenubarState, setMenubarEnabled } from './service.js';
import type { WindowsQuotaPanel } from '../quota-overview/windowsPanel.js';

/** Settings → Window behavior toggle. Local app renderer only; not a device-link capability. */
export function registerMenubarIpc(getTrayPanel: () => WindowsQuotaPanel | null): void {
  ipcMain.handle(MENUBAR_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return getTrayPanel()?.state ?? getMenubarState();
  });
  ipcMain.handle(MENUBAR_SET_ENABLED_CHANNEL, (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = requireBoolean(enabled, 'enabled');
    return getTrayPanel()?.setEnabled(value) ?? setMenubarEnabled(value);
  });
}
