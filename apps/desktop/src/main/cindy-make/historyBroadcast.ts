import { BrowserWindow } from 'electron';

import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';

export const CINDY_MAKE_HISTORY_CHANGED = 'cindy-make:history-changed';

/** Invalidate local Settings history after a background build reaches a terminal state. */
export function broadcastCindyMakeHistoryChanged(): void {
  const ownerStamp = captureDataOwnerBroadcastScope().ownerStamp;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(CINDY_MAKE_HISTORY_CHANGED, ownerStamp);
    } catch {
      // A closing renderer must not affect the completed build.
    }
  }
}
