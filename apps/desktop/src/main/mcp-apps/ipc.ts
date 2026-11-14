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
import { manageAppSettings } from '../app-settings/sections.js';
import { matchesGhostHostUiAttachment, type GhostHostUiContribution } from '@cindy/plugin-protocol';
import { preparePluginAttachmentResult } from './pluginAttachment.js';
import { resolveGhostAttachmentUrl } from '../mcp-integrations/ghostAttachmentResolve.js';
import { getActiveAppSession } from '../appSessionState.js';
import { stageLocalFileToCache, cleanupOwnedUnpersistedStagedChatAttachments } from '../file-browser/remote-file-cache.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { resolveSafe } from '../cindy-media/blobStore.desktop.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { GHOST_HANDOFF_MAX_BYTES_PER_FILE } from '../../shared/ghost.js';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  const providerCalls = new Map<string, Map<string, AbortController>>();
  const currentOwner = () => getCurrentDbClientSnapshot() ?? undefined;
  const pluginFiles = configurePluginAppearanceFiles(createPluginFileAccess({
    libraryPath: async (instance, relativePath) => {
      const { getGhostLibrarySlot } = await import('../cindy-brain/index.js');
      return getGhostLibrarySlot().resolvePanelFilePath(instance, relativePath);
    },
    libraryMime: mediaTypeForLibraryPath,
    openHandoff: async (instance, ref) => {
      const { getGhostHandoffStore } = await import('../cindy-brain/index.js');
      return getGhostHandoffStore().openForPage(instance, ref);
    },
  }));
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
    pluginFiles,
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
    for (const call of providerCalls.get(caller)?.values() ?? []) call.abort();
    providerCalls.delete(caller);
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
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'plugin-action-cancel') {
        const requestId = 'requestId' in raw && raw.requestId;
        if (typeof requestId !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
        providerCalls.get(caller)?.get(requestId)?.abort();
        return {};
      }
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'plugin-settings') {
        const input = raw as { instanceId?: unknown; operation?: unknown; patch?: unknown };
        if (typeof input.instanceId !== 'string' || !['get', 'update', 'reset'].includes(String(input.operation))) throw new Error('MCP_APP_INVALID_REQUEST');
        const entry = readPluginHostUi(input.instanceId);
        if (!entry?.host.settings?.length) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
        const assertCurrent = async () => {
          entry.config.plugin!.assertCurrent();
          if (readPluginHostUi(input.instanceId as string) !== entry || event.sender.isDestroyed()) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
        };
        return await manageAppSettings({ operation: input.operation as 'get' | 'update' | 'reset',
          section: `plugins.${input.instanceId}`, patch: input.patch as Record<string, unknown> | undefined }, assertCurrent);
      }
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'native-interest') {
        const subscription = raw as { epoch?: unknown; entries?: unknown };
        if (typeof subscription.epoch !== 'string' || subscription.epoch.length > 128) throw new Error('MCP_APP_INVALID_REQUEST');
        return { updates: nativePluginUi.subscribe(caller, subscription.epoch, parsePluginUiInterests(subscription.entries)) };
      }
      if (!remote && raw && typeof raw === 'object' && 'op' in raw && raw.op === 'plugin-action') {
        const action = raw as { instanceId?: unknown; id?: unknown; kind?: unknown; value?: unknown; input?: unknown; requestId?: unknown };
        if (typeof action.instanceId !== 'string' || typeof action.id !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
        const entry = readPluginHostUi(action.instanceId);
        const declaration = action.kind === 'command' ? entry?.host.commands?.find(command => command.id === action.id)
          : entry?.host.contributions?.find(contribution => contribution.id === action.id);
        if (!entry || !declaration?.tool) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
        const position = 'position' in declaration ? declaration.position : undefined;
        const temporaryInputs: string[] = [];
        const ownerId = position === 'composer.attachment' ? getActiveAppSession().dataOwnerId : null;
        const cleanup = (paths: string[]) => ownerId
          ? cleanupOwnedUnpersistedStagedChatAttachments({ ownerId, filePaths: paths }) : Promise.resolve();
        let controller: AbortController | undefined;
        if (position === 'composer.completion' || position === 'composer.attachment') {
          if (typeof action.requestId !== 'string' || !action.requestId || action.requestId.length > 128) throw new Error('MCP_APP_INVALID_REQUEST');
          let calls = providerCalls.get(caller);
          if (!calls) { calls = new Map(); providerCalls.set(caller, calls); }
          if (calls.has(action.requestId)) throw new Error('MCP_APP_INVALID_REQUEST');
          controller = new AbortController(); calls.set(action.requestId, controller);
        }
        try {
          const timeout = AbortSignal.timeout(position === 'composer.completion' ? 2000 : 30 * 60_000);
          const signal = controller ? AbortSignal.any([controller.signal, timeout]) : timeout;
          const owner = currentOwner();
          const scope = sessionId === null ? undefined : await assertSession(sessionId);
          const assertCurrent = async () => {
            signal.throwIfAborted();
            if (owner !== currentOwner() || readPluginHostUi(action.instanceId as string) !== entry || event.sender.isDestroyed()) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
            entry.config.plugin!.assertCurrent(sessionId ?? undefined);
            if (scope && sessionId !== null) {
              const latest = await assertSession(sessionId);
              if (latest.owner !== scope.owner || latest.session.clearedAt !== scope.session.clearedAt || latest.session.remoteHostId)
                throw new Error('MCP_APP_SESSION_UNAVAILABLE');
            }
            signal.throwIfAborted();
          };
          await assertCurrent();
          if (sessionId !== null && (await assertSession(sessionId)).session.remoteHostId) throw new Error('MCP_APP_OWNER_ONLY');
          let value: string | undefined;
          if (action.value !== undefined) {
            if (!('options' in declaration) || !Array.isArray(declaration.options) || typeof action.value !== 'string' ||
                !declaration.options.some(option => option.value === action.value)) throw new Error('MCP_APP_INVALID_REQUEST');
            value = action.value;
          }
          const args: Record<string, unknown> = { ...declaration.arguments, ...(value === undefined ? {} : { value }) };
          let attachments: string[] | undefined;
          const stage = async (name: string, buffer: Buffer, mimeType: string) => {
            await assertCurrent();
            if (!ownerId || !owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
            if (/^(image|audio|video|model)\//.test(mimeType)) {
              const media = await ingestMedia({ buffer, mimeType, refs: [] }, owner.client.drizzle);
              return { path: resolveSafe(media.url).absPath, url: media.url };
            }
            return { path: await stageLocalFileToCache({ ownerId, suggestedName: name, expectedSize: BigInt(buffer.length),
              copyTo: target => fs.writeFile(target, buffer, { flag: 'wx' }) }) };
          };
          if (position === 'session.menu') args.cindy_ui = { sessionId };
          if (position === 'composer.completion') {
            const input = action.input as { trigger?: unknown; query?: unknown } | undefined;
            if (!input || input.trigger !== declaration.trigger || typeof input.query !== 'string' || input.query.length > 32768 ||
                action.requestId === undefined) throw new Error('MCP_APP_INVALID_REQUEST');
            args.trigger = input.trigger; args.query = input.query;
          } else if (position === 'composer.attachment') {
            const input = action.input as { attachment?: { name?: unknown; uri?: unknown; size?: unknown; mimeType?: unknown } } | undefined;
            const file = input?.attachment;
            if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 200 || typeof file.uri !== 'string' ||
                typeof file.mimeType !== 'string' || file.mimeType.length > 256 || !Number.isSafeInteger(file.size) ||
                (file.size as number) < 1 || !matchesGhostHostUiAttachment((declaration as GhostHostUiContribution).accept,
                  file as { name: string; mimeType: string })) throw new Error('MCP_APP_INVALID_REQUEST');
            args.attachment = { name: file.name, size: file.size, mimeType: file.mimeType };
            if (path.isAbsolute(file.uri)) attachments = [file.uri];
            else if (/^(?:cindy-media:|xdt-image:)/.test(file.uri)) attachments = [resolveGhostAttachmentUrl(file.uri).absPath];
            else if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(file.uri)) {
              const encoded = file.uri.slice(file.uri.indexOf(',') + 1);
              if (encoded.length > Math.ceil(GHOST_HANDOFF_MAX_BYTES_PER_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('MCP_APP_INVALID_REQUEST');
              const buffer = Buffer.from(encoded, 'base64');
              if (buffer.length !== file.size || !sniffMediaMime(buffer)) throw new Error('MCP_APP_INVALID_REQUEST');
              await assertCurrent();
              if (!ownerId) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
              const source = await stageLocalFileToCache({ ownerId, suggestedName: file.name, expectedSize: BigInt(buffer.length),
                copyTo: target => fs.writeFile(target, buffer, { flag: 'wx' }) });
              temporaryInputs.push(source); attachments = [source];
            } else throw new Error('MCP_APP_INVALID_REQUEST');
          } else if (action.input !== undefined || action.requestId !== undefined) throw new Error('MCP_APP_INVALID_REQUEST');
          signal.throwIfAborted();
          const result = await host.callPluginAction(caller, sessionId, { id: action.id, serverId: entry.config.id,
            title: declaration.title, assertCurrent, ...(attachments ? { attachments } : {}) }, declaration.tool, args, signal);
          return position === 'composer.attachment'
            ? await preparePluginAttachmentResult(action.instanceId, result, { access: pluginFiles, stage, cleanup, assertCurrent, signal }) : result;
        } finally {
          if (temporaryInputs.length) await cleanup(temporaryInputs);
          if (controller) {
            const calls = providerCalls.get(caller); calls?.delete(action.requestId as string);
            if (!calls?.size) providerCalls.delete(caller);
          }
        }
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
              supply: (document, boundCaller, hostContext) =>
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
                  ), undefined, hostContext),
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
