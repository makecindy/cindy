import { BrowserWindow } from 'electron';

import { MAKER_PUSH } from '../maker-ipc/channels.js';
import type { CindyMakeGlobalState } from '../../shared/cindyMakeDoctor.js';

/** Push the Main-owned Cindy Make snapshot to every trusted renderer window. */
export function broadcastCindyMakeState(state: CindyMakeGlobalState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(MAKER_PUSH.CINDY_MAKE_STATE_CHANGED, state);
    } catch {
      // A closing renderer must not affect the operation running in Main.
    }
  }
}
