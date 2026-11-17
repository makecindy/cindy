import { createLiziMcpProviders, type ToolCallAuthorizer } from '@cindy/mcps';
import type { Session } from '@cindy/maker-core';
import type { DataOwnerPushStamp } from '../../../desktop/src/shared/dataOwnerPush.js';
import type { InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import { handlePluginHostToolRequest } from '../../../desktop/src/main/cindy-brain/hostToolSlot.js';
import { createProviderHostToolRuntime, authorizePluginHostToolCall, getPluginHostToolCaller } from '../../../desktop/src/main/mcp-integrations/hostToolCaller.js';
import { createTaskToolCallAuthorizer } from '../../../desktop/src/main/maker-ipc/taskToolCallAuthorizer.js';
import { createDesktopTaskActionAuthorizer } from '../../../desktop/src/main/maker-ipc/taskActionHost.js';
import { createTaskActionConfirmation } from '../../../desktop/src/main/maker-ipc/taskActionConfirmation.js';
import { createHistoryToolCallbacks } from '../../../desktop/src/main/mcp-integrations/historyToolCallbacks.js';
import { resolveHelperSurface } from '../../../desktop/src/main/mcp-integrations/helperSurface.js';
import { DeviceLinkError } from '@cindy/device-link';
import type { ChatHistoryReaderDeps } from '../../../desktop/src/main/mcp-integrations/remoteChatHistory.js';
import { getCurrentDbClientSnapshot, tryGetDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { HostTerminalService } from '../../../desktop/src/main/terminal/hostTerminalService.js';
import { createTerminalToolExecutor } from '../../../desktop/src/main/terminal/terminalToolAccess.js';
import { createFileToolExecutor } from '../../../desktop/src/main/cindy-brain/fileToolAccess.js';
import type { GhostFsSlot } from '../../../desktop/src/main/cindy-brain/fsSlot.js';
import type { HostStorageService } from '../../../desktop/src/main/cindy-brain/storageService.js';
import { createStorageToolExecutor } from '../../../desktop/src/main/cindy-brain/storageToolAccess.js';
import { HostServiceCatalog, createHostServiceToolExecutor } from '../../../desktop/src/main/cindy-brain/hostServiceCatalog.js';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.js';
import type { createHostConfirmations } from '../host-confirmations.js';

interface Options {
  profileDir: string;
  ownerId: string;
  owner(): DataOwnerPushStamp;
  current(): boolean;
  getGhost(id: string): InstalledGhost | null;
  getSession(id: string): Session | undefined;
  confirmations: ReturnType<typeof createHostConfirmations>;
  terminal?: HostTerminalService;
  files?: () => GhostFsSlot;
  storage?: () => HostStorageService;
  invokeRemote?: ChatHistoryReaderDeps['invokeRemote'];
  taskActions?: Omit<Parameters<typeof createDesktopTaskActionAuthorizer>[0], 'getSession' | 'confirm'>;
  t(key: string): string;
}

/** Pure Node assembly of the shared MCP providers, gateway and terminal service.
 * Agent tools and plugin calls receive the same provider objects and handlers. */
export function createHostToolService(options: Options) {
  const terminal = options.terminal ?? new HostTerminalService();
  let closed = false;
  const current = () => !closed && options.current();
  const authorizeTaskCall = createTaskToolCallAuthorizer({
    getDb: () => current() ? tryGetDbClient() : null,
    isScopeCurrent: db => current() && db === tryGetDbClient(),
    authorizePluginCall: authorizePluginHostToolCall,
    authorizeAction: options.taskActions ? createDesktopTaskActionAuthorizer({ ...options.taskActions,
      getSession: options.getSession, confirm: createTaskActionConfirmation({ getSession: options.getSession, t: options.t }),
    }) : async () => ({ ok: false, errorCode: 'HOST_NOT_READY', message: 'Task input authority is unavailable.' }),
  });
  const authorizeCall: ToolCallAuthorizer = async call => {
    const database = getCurrentDbClientSnapshot();
    const decision = await authorizeTaskCall(call);
    if (!decision.ok) return decision;
    const assertCurrent = () => {
      if (!current() || !database || database !== getCurrentDbClientSnapshot()) throw new Error('OWNER_SCOPE_CHANGED');
    };
    try { assertCurrent(); }
    catch { return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: 'Host account changed.' }; }
    return { ok: true, run: operation => {
      const run = async () => { assertCurrent(); const result = await operation(); assertCurrent(); return result; };
      return decision.run ? decision.run(run) : run();
    } };
  };
  const services = new HostServiceCatalog();
  // Node plugin installation and connection lifecycles are not connected yet.
  // Agent providers remain unchanged; plugins fail before setup.
  const supportsPluginServer = (server: string) => server !== 'cindy_computer';
  const providers = createLiziMcpProviders({
    xdtHelper: { authorizeCall,
      hostServices: createHostServiceToolExecutor(services, { pluginCall: getPluginHostToolCaller, getGhost: options.getGhost, supportsPluginServer }),
      resolveSurface: async ({ sessionId }) => {
        const db = current() ? tryGetDbClient() : null;
        return db ? resolveHelperSurface(db, sessionId) : 'restricted';
      },
      history: createHistoryToolCallbacks({ authorizeCall,
        invokeRemote: options.invokeRemote ?? (async () => { throw new DeviceLinkError('NOT_CONNECTED', 'Device Link is unavailable'); }) }),
      ...(options.files ? { files: createFileToolExecutor(options.files, getPluginHostToolCaller) } : {}),
      ...(options.storage ? { storage: createStorageToolExecutor(options.storage, getPluginHostToolCaller) } : {}),
      terminal: createTerminalToolExecutor({ service: terminal, owner: options.owner,
        pending: () => !current(), pluginCall: getPluginHostToolCaller, getGhost: options.getGhost,
        getSession: options.getSession, pluginDirectory: id => ownerScopedPath(options.profileDir, options.ownerId, 'ghost-fs', id) }),
    },
  });

  services.replace(providers);
  return {
    providers, terminal, services,
    request(id: string, payload: unknown, pageCurrent: () => boolean) {
      return handlePluginHostToolRequest(id, payload, () => current() && pageCurrent(), {
        owner: options.owner, getGhost: options.getGhost,
        createRuntime: (server, caller) => supportsPluginServer(server) ? createProviderHostToolRuntime(providers, server, caller) : null,
        unavailableRuntimeError: { errorCode: 'UNSUPPORTED_CAPABILITY',
          message: payload && typeof payload === 'object' && 'server' in payload && payload.server === 'cindy_computer'
            ? 'Computer control is not connected to this Node plugin runtime.'
            : 'This execution environment does not support the requested Host service.' },
      });
    },
    stopPlugin(id: string) { options.confirmations.cancelPlugin(id); terminal.disposePlugin(id); },
    close() { closed = true; services.replace([]); terminal.disposeScoped(); },
  };
}
