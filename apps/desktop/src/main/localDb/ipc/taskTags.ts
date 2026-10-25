import { createLogger } from '../../logger';
import { ipcMain, BrowserWindow } from 'electron';
import { getDbClient } from '../client/current';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import {
  tapWindowBroadcast,
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../../device-link/broadcast-tap.js';
import { broadcastSessionPatched } from './sessions';
import { createTaskTags } from '@cindy/app-runtime/taskTags';
const log = createLogger('taskTags');
export const { TASK_TAG_CHANNEL, executeTaskTags, registerTaskTagsIpc } = createTaskTags({
  logger: log,
  getDbClient,
  ipcMain,
  assertTrustedAppRendererEvent,
  tapWindowBroadcast,
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  broadcastSessionPatched,
  broadcastLocal(channel, payload, ...stamp) {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (isTrustedAppRendererWindow(window)) window.webContents.send(channel, payload, ...stamp);
      } catch {
        log.warn('task tag renderer broadcast failed');
      }
    }
  },
});
