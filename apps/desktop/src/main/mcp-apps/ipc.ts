import { createMcpAppsService } from './service.js';
import { extractIpcError } from '../../shared/ipcError.js';
import { pagePermissionGrants, onPagePermissionSessionChanged } from './pagePermissions.js';
import { getDesktopMcpToolApprovalPolicy } from '../maker-host/mcp-tool-approval-policy.js';
import { createPluginFileAccess } from './pluginFileAccess.js';
import { configurePluginAppearanceFiles } from './appearance.js';
import { mediaTypeForLibraryPath } from '../cindy-brain/runtime/ghostFiles.js';
import { ipcMain, shell, BrowserWindow, dialog, webContents } from 'electron';
import { bindPluginUiResource, finishPluginUiAction } from './hostUi.js';
import { readPluginHostUi } from '../mcp-integrations/plugin-app-registry.js';
import { nativePluginUi, parsePluginUiInterests } from './nativeRuntime.js';
import { t } from '../i18n.desktop.js';
import { saveAppDownload } from './downloadFile.js';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  InteractionRequest,
  InteractionDecision,
  AutoReviewDecision,
} from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { createMessage, broadcastMessageRow } from '../localDb/ipc/messages.js';
import { messageToCamel } from '../localDb/mapper.js';
import { recomputePrRefsForSession } from '../git-context/prRefsStore.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { getMcpAppRevisionKey } from '../secrets/providerSecretStore.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { getRemoteLinkCloseEpoch, remoteInvoke } from '../device-link/index.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { McpAppsHost, appServerRevision, type McpAppsHostDeps } from './host.js';
import { readAppServer, setMcpAppsHost } from './runtime.js';
import { MCP_APPS_INVOKE, parseMcpAppRecord } from '../../shared/mcpApps.js';
import { handleMcpAppOperation, handleMcpAppFrameOperation } from './operations.js';
import { RemoteMcpAppViews } from './remoteViews.js';
import {
  supplyMcpAppDocument,
  removeMcpAppDocument,
  assertMcpAppDocumentCaller,
  setMcpAppCallerCleanup,
  setMcpAppFileReader,
} from './sandboxProtocol.js';

export function registerMcpAppsIpc(
  send: McpAppsHostDeps['sendMessage'],
  request: (
    sessionId: string,
    input: InteractionRequest,
    signal: AbortSignal,
  ) => Promise<InteractionDecision>,
  review?: (
    sessionId: string,
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    originDescription?: string,
    toolDefinition?: Pick<Tool, 'name' | 'description' | 'inputSchema'>,
  ) => Promise<AutoReviewDecision>,
  allowPendingPage?: (sessionId: string, requestId: string) => void,
): void {
  let saving = false;
  const currentOwner = () => getCurrentDbClientSnapshot() ?? undefined;
  const { host, assertSession } = createMcpAppsService({
    currentOwner, readAppServer, getMcpAppRevisionKey, send, request, review, allowPendingPage,
    writeMessage: (_owner, sessionId, input, options) => createMessage(sessionId, input, {
      ...options, broadcastOwnerScope: captureDataOwnerBroadcastScope(),
    }),
    publishMessage: (_owner, sessionId, message) => broadcastMessageRow(sessionId, message, captureDataOwnerBroadcastScope()),
    downloadFile: async (input) => {
      if (saving) throw new Error('MCP_APP_DOWNLOAD_BUSY');
      saving = true;
      try {
        return await saveAppDownload({
          ...input,
          showSaveDialog: async (name) => {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
            const result = await dialog.showSaveDialog(win, { defaultPath: name });
            return result.canceled ? null : (result.filePath ?? null);
          },
        });
      } finally {
        saving = false;
      }
    },
    pluginFiles: configurePluginAppearanceFiles(createPluginFileAccess({
      libraryPath: async (instance, relativePath) => {
        const { getGhostLibrarySlot } = await import('../cindy-brain/index.js');
        return getGhostLibrarySlot().resolvePanelFilePath(instance, relativePath);
      },
      libraryMime: mediaTypeForLibraryPath,
      openHandoff: async (instance, ref) => {
        const { getGhostHandoffStore } = await import('../cindy-brain/index.js');
        return getGhostHandoffStore().openForPage(instance, ref);
      },
    })),
    authorizeGlobalTool: async (_sessionId, tool, args, signal, source) => {
      signal.throwIfAborted();
      const owner = currentOwner();
      const config = source ? readAppServer(source.serverId) : undefined;
      if (!owner || !config?.plugin) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
      config.plugin.assertCurrent();
      const call = { ghost_id: config.plugin.ghostId ?? config.plugin.instance,
        ...(config.plugin.namespace !== undefined ? { namespace: config.plugin.namespace } : {}), tool: tool.name, args };
      if (getDesktopMcpToolApprovalPolicy({ serverName: 'cindy', toolName: 'ghost_call', toolParams: call }) === 'auto-approve') return;
      const match = /^renderer:(\d+)$/.exec(source?.caller ?? '');
      const contents = match ? webContents.fromId(Number(match[1])) : undefined;
      const window = contents ? BrowserWindow.fromWebContents(contents) : null;
      if (!window || window.isDestroyed()) throw new Error('MCP_APP_OWNER_ONLY');
      const answer = await dialog.showMessageBox(window, { type: 'question', title: source!.title,
        message: tool.title ?? tool.name, detail: JSON.stringify(args, null, 2),
        buttons: [t('common.cancel'), t('agentIsland.native.allowOnce')], defaultId: 0, cancelId: 0 });
      signal.throwIfAborted();
      if (owner !== currentOwner()) throw new Error('MCP_APP_OWNER_CHANGED');
      config.plugin.assertCurrent();
      if (answer.response !== 1) throw new Error('MCP_APP_TOOL_DENIED');
      return;
    },
    disposeDocument: removeMcpAppDocument,
  });
  setMcpAppsHost(host);
  setMcpAppFileReader((id, token, request) => host.readPluginFile(id, token, request));
  const remoteViews = new RemoteMcpAppViews({
    owner: currentOwner,
    closeEpoch: getRemoteLinkCloseEpoch,
    invoke: async (deviceId, sessionId, input, preSend) => {
      if (!getAppCapabilities().canUseDeviceLink) throw new Error('MCP_APP_OWNER_ONLY');
      const result = await remoteInvoke(deviceId, MCP_APPS_INVOKE, [sessionId, input], { preSend });
      if (result.ok) return result.result;
      if (result.error.code === 'CHANNEL_NOT_ALLOWED')
        throw new Error('MCP_APP_CHANNEL_NOT_ALLOWED');
      throw new Error(result.error.message);
    },
    openLink: (url) => shell.openExternal(url),
  });
  setMcpAppCallerCleanup(async (caller) => {
    nativePluginUi.release(caller);
    await Promise.allSettled([host.releaseCaller(caller), remoteViews.releaseCaller(caller)]);
  });
  ipcMain.removeHandler(MCP_APPS_INVOKE);
  ipcMain.handle(MCP_APPS_INVOKE, async (event, sessionId: unknown, raw: unknown) => {
    const remote = getDeviceLinkInvokeContext();
    if (remote?.sharedTask) throwIpcError('PRECONDITION_FAILED', 'MCP_APP_OWNER_ONLY');
    if (!remote) assertTrustedAppRendererEvent(event);
    if (typeof sessionId !== 'string' && (sessionId !== null || remote)) throwIpcError('INVALID_PARAMS', 'MCP_APP_INVALID_REQUEST');
    const caller = remote ? `device:${remote.controllerDeviceId}` : `renderer:${event.sender.id}`;
    try {
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'native-interest') {
        const subscription = raw as { epoch?: unknown; entries?: unknown };
        if (typeof subscription.epoch !== 'string' || subscription.epoch.length > 128) throw new Error('MCP_APP_INVALID_REQUEST');
        return { updates: nativePluginUi.subscribe(caller, subscription.epoch, parsePluginUiInterests(subscription.entries)) };
      }
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'plugin-action') {
        const action = raw as { instanceId?: unknown; id?: unknown; kind?: unknown; value?: unknown };
        if (typeof action.instanceId !== 'string' || typeof action.id !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
        const entry = readPluginHostUi(action.instanceId);
        const declaration = action.kind === 'command' ? entry?.host.commands?.find(command => command.id === action.id)
          : entry?.host.contributions?.find(contribution => contribution.id === action.id);
        if (!entry || !declaration?.tool) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
        const owner = currentOwner();
        const scope = sessionId === null ? undefined : await assertSession(sessionId);
        const assertCurrent = async () => {
          if (owner !== currentOwner() || readPluginHostUi(action.instanceId as string) !== entry || event.sender.isDestroyed()) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
          entry.config.plugin!.assertCurrent(sessionId ?? undefined);
          if (scope && sessionId !== null) {
            const latest = await assertSession(sessionId);
            if (latest.owner !== scope.owner || latest.session.clearedAt !== scope.session.clearedAt || latest.session.remoteHostId)
              throw new Error('MCP_APP_SESSION_UNAVAILABLE');
          }
        };
        await assertCurrent();
        if (sessionId !== null && (await assertSession(sessionId)).session.remoteHostId) throw new Error('MCP_APP_OWNER_ONLY');
        let value: string | undefined;
        if (action.value !== undefined) {
          if (!('options' in declaration) || !Array.isArray(declaration.options) || typeof action.value !== 'string' ||
              !declaration.options.some(option => option.value === action.value)) throw new Error('MCP_APP_INVALID_REQUEST');
          value = action.value;
        }
        return await host.callPluginAction(caller, sessionId, { id: action.id, serverId: entry.config.id,
          title: declaration.title, assertCurrent }, declaration.tool,
          { ...declaration.arguments, ...(value === undefined ? {} : { value }) }, AbortSignal.timeout(30 * 60_000));
      }
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'host-result') {
        const reply = raw as { requestId?: unknown; result?: unknown; error?: unknown };
        if (typeof reply.requestId !== 'string' || reply.error !== undefined && typeof reply.error !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
        finishPluginUiAction(caller, reply.requestId, reply.result, reply.error as string | undefined);
        return {};
      }
      if (raw && typeof raw === 'object' && 'deviceId' in raw) {
        // Incoming device-link calls cannot use this local-only route to pivot to another computer.
        if (remote) throw new Error('MCP_APP_INVALID_REQUEST');
        if (sessionId === null) throw new Error('MCP_APP_INVALID_SCOPE');
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
              resource: async (source) => {
                const scope = sessionId === null ? undefined : await assertSession(sessionId);
                if (scope?.session.remoteHostId) throw new Error('MCP_APP_OWNER_ONLY');
                return bindPluginUiResource(caller, sessionId, source.instanceId, source.viewId, config => host.serverRevision(config), async () => {
                  if (!scope || sessionId === null) return;
                  const latest = await assertSession(sessionId);
                  if (latest.owner !== scope.owner || latest.session.clearedAt !== scope.session.clearedAt || latest.session.remoteHostId)
                    throw new Error('MCP_APP_SESSION_UNAVAILABLE');
                }, scope ? { title: scope.session.title, workingDir: scope.session.workingDir, model: scope.session.model } : undefined);
              },
              supply: (document, boundCaller) =>
                supplyMcpAppDocument(document, boundCaller, (input) =>
                  handleMcpAppFrameOperation(
                    host,
                    boundCaller,
                    sessionId,
                    document.viewId,
                    input,
                    async (url) => {
                      assertMcpAppDocumentCaller(document.viewId, boundCaller);
                      await shell.openExternal(url);
                    },
                  ),
                ),
            },
      );
    } catch (error) {
      // device-link serializes the execution Host's IPC prefix. Unwrap that
      // envelope before applying the same public-code boundary on the viewer.
      const message = error instanceof Error
        ? (extractIpcError(new Error(error.message))?.message ?? error.message) : '';
      const code = /^(?:MCP_APP_[A-Z_]+|MCP_PLUGIN_(?:UNAVAILABLE|CSP_DOMAIN_NOT_DECLARED))$/.test(message)
        ? message : 'MCP_APP_REQUEST_FAILED';
      throwIpcError('PRECONDITION_FAILED', code);
    }
  });
}
