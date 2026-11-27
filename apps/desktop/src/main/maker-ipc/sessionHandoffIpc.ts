import { ipcMain } from 'electron';
import { registerSessionHandoffHandlers } from './sessionHandoffCore.js';

export { createSessionHandoffHandler, SESSION_HANDOFF_CAPABILITY } from './sessionHandoffCore.js';
export type { SessionHandoffSendParams, SessionHandoffSendResult } from './sessionHandoffCore.js';

export function registerSessionHandoffIpc(
  deps: Parameters<typeof registerSessionHandoffHandlers>[1],
): void {
  registerSessionHandoffHandlers(ipcMain, deps);
}
