import {createPersistedMcpAppsHostDeps} from '@cindy/app-runtime/mcp-apps/persistedHost';
import { ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { InteractionRequest, InteractionDecision } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { createMessage, broadcastMessageRow } from '../localDb/ipc/messages.js';
import { messageToCamel } from '../localDb/mapper.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { getMcpAppRevisionKey } from '../secrets/providerSecretStore.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { getRemoteLinkCloseEpoch, remoteInvoke } from '../device-link/index.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { McpAppsHost, type McpAppsHostDeps } from './host.js';
import { readAppServer, setMcpAppsHost } from './runtime.js';
import { MCP_APPS_INVOKE, parseMcpAppRecord } from '../../shared/mcpApps.js';
import { handleMcpAppOperation, handleMcpAppFrameOperation } from './operations.js';
import { RemoteMcpAppViews } from './remoteViews.js';
import {
  supplyMcpAppDocument,
  removeMcpAppDocument,
  assertMcpAppDocumentCaller,
  setMcpAppCallerCleanup,
} from './sandboxProtocol.js';

export function registerMcpAppsIpc(
  send: McpAppsHostDeps['sendMessage'],
  request: (
    sessionId: string,
    input: InteractionRequest,
    signal: AbortSignal,
  ) => Promise<InteractionDecision>,
): void {
  const currentOwner = () => getCurrentDbClientSnapshot() ?? undefined;
  const host=new McpAppsHost(createPersistedMcpAppsHostDeps({currentOwner,captureDataOwnerBroadcastScope,createMessage,broadcastMessageRow,getMcpAppRevisionKey,readAppServer,send,request,removeMcpAppDocument,logger:createLogger('mcp-apps')}));
  setMcpAppsHost(host);
  const remoteViews = new RemoteMcpAppViews({
    owner: currentOwner,
    closeEpoch: getRemoteLinkCloseEpoch,
    invoke: async (deviceId, sessionId, input, preSend) => {
      if (!getAppCapabilities().canUseDeviceLink) throw new Error('MCP_APP_OWNER_ONLY');
      const result = await remoteInvoke(deviceId, MCP_APPS_INVOKE, [sessionId, input], { preSend });
      if (result.ok) return result.result;
      if (result.error.code === 'CHANNEL_NOT_ALLOWED') throw new Error('MCP_APP_CHANNEL_NOT_ALLOWED');
      throw new Error(result.error.message);
    },
    openLink: (url) => shell.openExternal(url),
  });
  setMcpAppCallerCleanup(async (caller) => {
    await Promise.allSettled([host.releaseCaller(caller), remoteViews.releaseCaller(caller)]);
  });
  ipcMain.removeHandler(MCP_APPS_INVOKE);
  ipcMain.handle(MCP_APPS_INVOKE, async (event, sessionId: unknown, raw: unknown) => {
    const remote = getDeviceLinkInvokeContext();
    if (remote?.sharedTask) throwIpcError('PRECONDITION_FAILED', 'MCP_APP_OWNER_ONLY');
    if (!remote) assertTrustedAppRendererEvent(event);
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'MCP_APP_INVALID_REQUEST');
    const caller = remote ? `device:${remote.controllerDeviceId}` : `renderer:${event.sender.id}`;
    try {
      if (raw && typeof raw === 'object' && 'deviceId' in raw) {
        // Incoming device-link calls cannot use this local-only route to pivot to another computer.
        if (remote) throw new Error('MCP_APP_INVALID_REQUEST');
        return await remoteViews.control(caller, raw.deviceId, sessionId, raw);
      }
      return await handleMcpAppOperation(
        host,
        caller,
        sessionId,
        raw,
        remote
          ? undefined
          : {
              supply: (document, boundCaller) => supplyMcpAppDocument(document, boundCaller, (input) =>
                handleMcpAppFrameOperation(host, boundCaller, sessionId, document.viewId, input, async (url) => {
                  assertMcpAppDocumentCaller(document.viewId, boundCaller);
                  await shell.openExternal(url);
                })),
            },
      );
    } catch (error) {
      const code =
        error instanceof Error && /^MCP_APP_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'MCP_APP_REQUEST_FAILED';
      throwIpcError('PRECONDITION_FAILED', code);
    }
  });
}
