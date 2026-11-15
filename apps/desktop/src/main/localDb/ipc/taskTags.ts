import { createLogger } from '../../logger';
import { ipcMain, BrowserWindow } from 'electron';
import type { TaskTagRequest } from '@cindy/maker-shared';
import { createTaskTagService, TASK_TAG_CHANNEL } from './taskTagService.js';
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

const log = createLogger('taskTags');
export { TASK_TAG_CHANNEL };
export const { executeTaskTags } = createTaskTagService({
  captureDataOwnerBroadcastScope: (...args) => captureDataOwnerBroadcastScope(...args),
  isDataOwnerBroadcastScopeCurrent: (...args) => isDataOwnerBroadcastScopeCurrent(...args),
  tapWindowBroadcast: (...args) => tapWindowBroadcast(...args),
  broadcastSessionPatched: (...args) => broadcastSessionPatched(...args),
  broadcastTagsChanged(payload, ownerStamp) {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (isTrustedAppRendererWindow(window)) window.webContents.send('local-db:task-tags:changed', payload, ownerStamp);
      } catch { log.warn('task tag renderer broadcast failed'); }
    }
  },
});
export function registerTaskTagsIpc(): void {
  ipcMain.handle(TASK_TAG_CHANNEL, async (event, request: TaskTagRequest) => {
    assertTrustedAppRendererEvent(event);
    return executeTaskTags(request);
  });
}
