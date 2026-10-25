import { app, ipcMain } from 'electron';
import { REMOTE_TERMINAL_CHANNEL, RemoteTerminalHost } from '@cindy/terminal-core';
import { isProviderSharePeer, isSharedTaskPeer } from '@cindy/device-link';
import { getActiveAuthRealm, getCurrentDataOwnerId, getCurrentUserId, onAuthStateChange } from '../authManager.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** The existing local terminal tabs keep their window lifecycle. Remote shells
 * have a separate controller lifetime and survive a controller disconnect. */
export function registerRemoteTerminal(): void {
  const scope = () => { const user = getCurrentUserId(); return user ? JSON.stringify([getActiveAuthRealm(), user,getCurrentDataOwnerId()]) : null; };
  const host = new RemoteTerminalHost({ getScope: scope, logger: createLogger('terminal/remote') });
  let current = scope();
  const unsubscribe = onAuthStateChange(() => { const next = scope(); if (next !== current) { host.close(); current = next; } });
  app.once('will-quit', () => { unsubscribe(); host.close(); });
  ipcMain.handle(REMOTE_TERMINAL_CHANNEL, async (_event, request: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (!context || context.sharedTask || isProviderSharePeer(context.controllerDeviceId) || isSharedTaskPeer(context.controllerDeviceId)) throwIpcError('PERMISSION_DENIED', 'Remote terminal requires a same-account controller');
    const assertCurrent = () => {
      const settings = readDeviceLinkSettings();
      if (!settings.remoteControlEnabled || settings.revokedControllers.includes(context.controllerDeviceId)) throwIpcError('PERMISSION_DENIED', 'Remote control is unavailable');
    };
    try { return await host.invoke(request, { controller: context.controllerDeviceId, assertCurrent }); }
    catch (error) {
      if(error&&typeof error==='object'&&'code' in error&&error.code==='PERMISSION_DENIED')throw error;
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'TERMINAL_OPERATION_FAILED';
      throwIpcError(code.startsWith('INVALID_')?'INVALID_PARAMS':code==='AUTH_REQUIRED'||code==='OWNER_CHANGED'?'PERMISSION_DENIED':'INTERNAL',code);
    }
  });
}
