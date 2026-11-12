import { BrowserWindow } from 'electron';

import type { MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';

/** Push managed source preparation state to every trusted renderer window. */
export function broadcastCindyMakeSourceStatus(status: MakeSourceStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('cindy-make:source-status', status);
  }
}
