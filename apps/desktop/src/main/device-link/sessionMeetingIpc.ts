import { ipcMain } from 'electron';
import { getCurrentUserId } from '../authManager.js';
import { SESSION_MEETING_ACCOUNT_CHANNEL, SESSION_MEETING_HOST_CHANNEL } from '@cindy/device-link';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { requireSessionMeetingHost } from './sessionMeetingRuntime.js';
import { sessionMeetingApi } from './sessionMeetingApi.js';
import { executeSessionMeetingAccountCommand, executeSessionMeetingHostCommand } from './sessionMeetingCommands.js';

/** Narrow Renderer adapter; account operations cannot be tunneled on somebody else's login. */
export function registerSessionMeetingIpc(available: () => boolean): void {
  ipcMain.handle(SESSION_MEETING_HOST_CHANNEL, async (event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.meeting) throwIpcError('PERMISSION_DENIED', 'Only the meeting owner can manage members');
    if (!context) assertTrustedAppRendererEvent(event);
    return executeSessionMeetingHostCommand(raw, { available, host: requireSessionMeetingHost });
  });
  ipcMain.handle(SESSION_MEETING_ACCOUNT_CHANNEL, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Meeting account operations are local only');
    assertTrustedAppRendererEvent(event);
    if (!available()) throwIpcError('UNSUPPORTED_CAPABILITY', 'Meeting mode requires updated clients and server');
    return executeSessionMeetingAccountCommand(raw, sessionMeetingApi, getCurrentUserId() ?? undefined);
  });
}
