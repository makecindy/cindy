import { ipcMain } from 'electron';
import { MAKER_INVOKE } from './channels.js';
import { createSessionIpcAdapter } from '../session-controller/ipcAdapter.js';
import { localSessionHost } from '../session-controller/localHost.js';
import { sessionHistory } from '../session-controller/history.js';

export function registerMakerRewindIpc(): void {
  const sessionIpc = createSessionIpcAdapter(ipcMain, { ...localSessionHost, interactionSessionId: () => undefined });
  sessionIpc.handle(MAKER_INVOKE.REWIND_PREVIEW, (_event, sessionId, clientId) => sessionHistory.previewRewind(sessionId, clientId));
  sessionIpc.handle(MAKER_INVOKE.REWIND_COMMIT, (_event, sessionId, clientId, options) => sessionHistory.rewind(sessionId, clientId, options));
}
