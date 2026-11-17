import { createLiziMcpProviders, type ToolCallAuthorizer } from '@cindy/mcps';
import type { Session } from '@cindy/maker-core';
import type { DataOwnerPushStamp } from '../../../desktop/src/shared/dataOwnerPush.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import type { GhostManager } from '../../../desktop/src/main/cindy-brain/GhostManager.js';
import { handlePluginHostToolRequest } from '../../../desktop/src/main/cindy-brain/hostToolSlot.js';
import { ensurePluginTaskApproval, hasPluginHostToolGroupApproval, PluginTaskApprovalGate } from '../../../desktop/src/main/cindy-brain/taskCapability.js';
import type { GhostHostToolGroup } from '@cindy/plugin-protocol';
import { createProviderHostToolRuntime, authorizePluginHostToolCall, getPluginHostToolCaller } from '../../../desktop/src/main/mcp-integrations/hostToolCaller.js';
import { createTaskToolCallAuthorizer } from '../../../desktop/src/main/maker-ipc/taskToolCallAuthorizer.js';
import { createDesktopTaskActionAuthorizer } from '../../../desktop/src/main/maker-ipc/taskActionHost.js';
import { createTaskActionConfirmation } from '../../../desktop/src/main/maker-ipc/taskActionConfirmation.js';
import { createHistoryToolCallbacks } from '../../../desktop/src/main/mcp-integrations/historyToolCallbacks.js';
import { resolveHelperSurface } from '../../../desktop/src/main/mcp-integrations/helperSurface.js';
import { DeviceLinkError } from '@cindy/device-link';
import type { ChatHistoryReaderDeps } from '../../../desktop/src/main/mcp-integrations/remoteChatHistory.js';
import { getCurrentDbClientSnapshot, tryGetDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { getDesktopMcpToolApprovalPolicy } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.js';
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
  manager: Pick<GhostManager, 'approveTaskCapability'>;
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
  const gate = new PluginTaskApprovalGate();
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
  // Desktop's process-local approval cannot be reconstructed from forwarded
  // caller metadata. Agent providers remain unchanged; plugins fail before setup.
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

  async function approveGroup(id: string, group: GhostHostToolGroup, pageCurrent: () => boolean, explicit = false): Promise<boolean> {
    if (!current() || !pageCurrent()) return false;
    if (hasPluginHostToolGroupApproval(options.getGhost(id), group)) return true;
    const owner = options.owner();
    const revision = ghostInstallApprovalToken(options.getGhost(id)?.approval);
    const active = () => current() && pageCurrent() && options.owner().dataOwnerId === owner.dataOwnerId
      && options.owner().ownerGeneration === owner.ownerGeneration && ghostInstallApprovalToken(options.getGhost(id)?.approval) === revision;
    return gate.request(`${id}:${group}`, JSON.stringify([owner, revision]), explicit, () => ensurePluginTaskApproval(id, {
      getGhost: options.getGhost, isCurrent: active,
      confirm: facts => options.confirmations.install({ purpose: 'task-capability', initiator: 'user', origin: 'local-file', facts }),
      approve: (pluginId, expected, check) => options.manager.approveTaskCapability(pluginId, expected, check, `host-tools:${group}`),
    }, `host-tools:${group}`));
  }

  services.replace(providers);
  return {
    providers, terminal, services, approveGroup,
    request(id: string, payload: unknown, pageCurrent: () => boolean) {
      return handlePluginHostToolRequest(id, payload, () => current() && pageCurrent(), {
        owner: options.owner, getGhost: options.getGhost,
        createRuntime: (server, caller) => supportsPluginServer(server) ? createProviderHostToolRuntime(providers, server, caller) : null,
        unavailableRuntimeError: { errorCode: 'UNSUPPORTED_CAPABILITY',
          message: 'This execution environment does not support the requested Host service.' },
        approveGroup,
        policy: (serverName, name, args) => getDesktopMcpToolApprovalPolicy({ serverName, toolName: 'call_tool', toolParams: { name, args } }),
        confirm: ({ pluginId, pluginName, server, tool, args }) => options.confirmations.confirm({
          ghostId: pluginId, ghostName: pluginName,
          body: `${options.t('settings.ghosts.perm.hostToolCallMessage').replaceAll('{{name}}', () => pluginName)
            .replaceAll('{{server}}', () => server).replaceAll('{{tool}}', () => tool)}\n\n${pluginId}\n\n${JSON.stringify(args, null, 2)}`,
          confirmText: options.t('settings.ghosts.connections.confirmAllow'), cancelText: null, danger: false,
        }),
      });
    },
    stopPlugin(id: string) { options.confirmations.cancelPlugin(id); terminal.disposePlugin(id); },
    close() { closed = true; services.replace([]); terminal.disposeScoped(); },
  };
}
