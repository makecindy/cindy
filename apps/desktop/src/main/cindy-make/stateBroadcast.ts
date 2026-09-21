import { BrowserWindow } from 'electron';

import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import type { CindyMakeGlobalState } from '../../shared/cindyMakeDoctor.js';
import { broadcastMakeRemoteChanged } from './remoteBroadcast.js';

/** Push the Main-owned Cindy Make snapshot to every trusted renderer window. */
export function broadcastCindyMakeState(state: CindyMakeGlobalState): void {
  for (const report of Object.values(state.tasks ?? {}))
    if (report.task?.sessionId) broadcastMakeRemoteChanged(report.task.sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(MAKER_PUSH.CINDY_MAKE_STATE_CHANGED, {
        ...state,
        ownerStamp: captureDataOwnerBroadcastScope().ownerStamp,
      });
    } catch {
      // A closing renderer must not affect the operation running in Main.
    }
  }
}
