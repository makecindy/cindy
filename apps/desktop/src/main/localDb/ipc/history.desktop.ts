import { ipcMain } from 'electron';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { createRemoteHistoryHandler, type RemoteHistoryIpcDeps } from './history.js';

export function registerRemoteHistoryIpc(deps?: RemoteHistoryIpcDeps): void {
  const readHistory = createRemoteHistoryHandler(deps);
  ipcMain.handle(DL_HISTORY_MESSAGES_CHANNEL, (_event, value: unknown) => readHistory(value));
}
