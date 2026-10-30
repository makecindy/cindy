import { BrowserWindow } from 'electron';

import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import type { CindyMakeGlobalState } from '../../shared/cindyMakeDoctor.js';
import {
  broadcastMakeRemoteChanged,
  broadcastMakeRemoteCollectionChanged,
} from './remoteBroadcast.js';

let lastGlobalProjection: string | undefined;

/** Push the Main-owned Cindy Make snapshot to every trusted renderer window. */
export function broadcastCindyMakeState(state: CindyMakeGlobalState): void {
  const scope = captureDataOwnerBroadcastScope();
  for (const report of Object.values(state.tasks ?? {}))
    if (report.task?.sessionId) broadcastMakeRemoteChanged(report.task.sessionId, scope);
  // personalRemote/personalSync are device-level projections that also appear in
  // finished task resources. Those tasks are intentionally omitted from
  // state.tasks, so a collection-level invalidation is required when the global
  // projection changes.
  const globalProjection = JSON.stringify([
    scope.ownerScopeKey,
    scope.ownerStamp,
    state.personalRemote,
    state.personalSync,
  ]);
  if (globalProjection !== lastGlobalProjection) {
    lastGlobalProjection = globalProjection;
    broadcastMakeRemoteCollectionChanged(scope);
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(MAKER_PUSH.CINDY_MAKE_STATE_CHANGED, {
        ...state,
        ownerStamp: scope.ownerStamp,
      });
    } catch {
      // A closing renderer must not affect the operation running in Main.
    }
  }
}
