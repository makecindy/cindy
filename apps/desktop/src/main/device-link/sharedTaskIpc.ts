import { ipcMain } from 'electron';
import { getCurrentUserId } from '../authManager.js';
import { SHARED_TASK_ACCOUNT_CHANNEL, SHARED_TASK_HOST_CHANNEL } from '@cindy/device-link';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { requireSharedTaskHost } from './sharedTaskRuntime.js';
import { sharedTaskApi } from './sharedTaskApi.js';
import { executeSharedTaskAccountCommand, executeSharedTaskHostCommand } from './sharedTaskCommands.js';

/** Narrow Renderer adapter; account operations cannot be tunneled on somebody else's login. */
export function registerSharedTaskIpc(available: () => boolean, relayOnline: () => boolean): void {
  const availableOnline = () => {
    // A transient disconnect is not evidence of an unsupported server version.
    if (!relayOnline()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'SharedTask relay is not connected');
    return available();
  };
  ipcMain.handle(SHARED_TASK_HOST_CHANNEL, async (event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Only the sharedTask owner can manage members');
    if (!context) assertTrustedAppRendererEvent(event);
    return executeSharedTaskHostCommand(raw, { available: availableOnline, host: requireSharedTaskHost });
  });
  ipcMain.handle(SHARED_TASK_ACCOUNT_CHANNEL, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'SharedTask account operations are local only');
    assertTrustedAppRendererEvent(event);
    if (!availableOnline()) throwIpcError('UNSUPPORTED_CAPABILITY', 'SharedTask mode requires updated clients and server');
    return executeSharedTaskAccountCommand(raw, sharedTaskApi, getCurrentUserId() ?? undefined, {
      hostedIds: () => { try { return requireSharedTaskHost().activeSharedTaskIds(); } catch { return []; } },
      closeHosted: (sharedTaskId) => requireSharedTaskHost().close(sharedTaskId),
    });
  });
}
