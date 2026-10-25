import { createSubagentService } from '@cindy/app-runtime/subagentService';
import { app, BrowserWindow, ipcMain } from 'electron';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp } from '../../appSessionState.js';
import {
  getDeviceLinkInvokeContext,
  isDeviceLinkInvoke,
} from '../../device-link/invoke-context.js';
import * as broadcastTap from '../../device-link/broadcast-tap.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import * as store from '../subagentRuns.js';
export const {
  __resetSubagentReconcileFingerprintsForTests,
  broadcastSubagentRunsChanged,
  broadcastSubagentRunsInvalidated,
  registerSubagentRunsIpc,
} = createSubagentService({
  ipc: ipcMain,
  activeOwnerScopeKey: () => activeOwnerScopeKey(),
  getActiveDataOwnerPushStamp: () => getActiveDataOwnerPushStamp(),
  getDeviceLinkInvokeContext: () => getDeviceLinkInvokeContext(),
  isDeviceLinkInvoke: () => isDeviceLinkInvoke(),
  assertTrustedAppRendererEvent: (...args) => assertTrustedAppRendererEvent(...args),
  broadcastTap: {
    isDataOwnerBroadcastScopeCurrent: (...args) =>
      broadcastTap.isDataOwnerBroadcastScopeCurrent(...args),
    tapWindowBroadcast: (...args) => broadcastTap.tapWindowBroadcast(...args),
  },
  store,
  userDataDirectory: () => app.getPath('userData'),
  broadcastTrustedLocal(channel, payload, ...stamp) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) {
        try {
          window.webContents.send(channel, payload, ...stamp);
        } catch {
          /* Closing renderers do not interrupt other recipients. */
        }
      }
    }
  },
});
