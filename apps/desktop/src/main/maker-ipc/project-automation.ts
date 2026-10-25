import { BrowserWindow, ipcMain } from 'electron';
import { createProjectAutomationIpc } from '@cindy/app-runtime/projectAutomationIpc';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { projectAutomationConsentToCamel } from '../localDb/mapper.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
const log = createLogger('maker-ipc:project-automation');
function broadcast(channel: string, payload: unknown): void {
  // device-link tap:project-automation:event 在 PUSH_FORWARD_ALLOWLIST,补 tap 才会转发给控制端。
  tapWindowBroadcast(channel, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

export const { registerProjectAutomationIpc } = createProjectAutomationIpc({
  ipcMain,
  getDbClient,
  projectAutomationConsentToCamel,
  log,
  broadcast,
});
