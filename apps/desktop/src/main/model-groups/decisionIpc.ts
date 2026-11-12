/** 模型组「最近的选择」的读取通道：设置页总览用。只接受可信的主界面。 */
import { ipcMain } from 'electron';

import { MODEL_GROUP_DECISIONS_IPC } from '../../shared/modelGroupDecisions.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { readModelGroupDecisions } from './decisionLog.js';

export function registerModelGroupDecisionIpc(): void {
  ipcMain.handle(MODEL_GROUP_DECISIONS_IPC, (event) => {
    assertTrustedAppRendererEvent(event);
    return readModelGroupDecisions();
  });
}
