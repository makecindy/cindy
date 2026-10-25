import { AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL } from '@cindy/maker-shared/agentIsland';
import { createAgentIslandRuntime } from '@cindy/app-runtime/session-activity/service';
import { createAgentIslandCompanionIdentity } from '@cindy/app-runtime/session-activity/companionIdentity';
import { createLocalizedToolRowWording } from '@cindy/app-runtime/session-activity/toolWording';
import { createSessionAttention } from '@cindy/app-runtime/session-activity/attention';
import { createSessionActivityBridge } from '@cindy/app-runtime/session-activity/bridge';
import { createHiddenSessionRegistry } from '@cindy/runtime-db/hiddenSessionRegistry';
import type { AgentIslandRuntimeHost, AgentIslandWindow } from '@cindy/app-runtime/session-activity/ports';
import type { AgentIslandService } from '@cindy/app-runtime/session-activity/service';
import { runtimeResourcesDirectory } from '../platform.js';
import type { TaskInvocationContext } from './host.js';
import type { NodeDatabase } from '../database.js';
import type { TerminalConversations } from './conversations.js';

type BridgeHost = Parameters<typeof createSessionActivityBridge>[0];
type RuntimeHost = AgentIslandRuntimeHost<AgentIslandWindow, TaskInvocationContext>;

/** The original coordinator running through its existing headless path. There
 * is no display host, Electron module or substitute window in this process. */
export async function createTerminalSessionActivity(host: Pick<RuntimeHost,
  'log' | 't' | 'withSessionRouteLock' | 'patchSessionMetaInDb' | 'hasImBinding' | 'remoteInvoke' | 'assertTrustedAppRendererEvent' | 'isDeviceLinkInvoke'> &
  Pick<BridgeHost, 'getCoordinator' | 'getBookkeeping' | 'getSession' | 'isKnownOrcaWorkerSession' | 'isRemoteAuthRetryErrorEvent' | 'isGatewayProxyTokenRecoveryErrorEvent'> & {
  database: NodeDatabase;
  conversations: TerminalConversations;
  current(): boolean;
  resolveMedia(url: string): { absPath: string };
  emit(channel: string, payload: unknown): void;
  isCompletionHandledByTeammate?(id: string): Promise<boolean>;
}) {
  const handlers = new Map<string, (context: TaskInvocationContext, ...args: unknown[]) => unknown>();
  const ipcMain = { handle: (channel: string, handler: (context: TaskInvocationContext, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); } };
  const owner = host.database.getCurrentDbClientSnapshot()!;
  let service: AgentIslandService;
  let companionSink: { companionChanged(id: string): void; groupChanged(id: string): void } | undefined;
  const attention = createSessionAttention<null, TaskInvocationContext>({
    ipcMain, assertTrustedAppRendererEvent: host.assertTrustedAppRendererEvent,
    getActiveAppSession: () => ({ dataOwnerId: host.current() ? owner.userId : null, generation: owner.clientEpoch }),
    throwIpcError: (code, message) => { throw Object.assign(new Error(message), { code }); },
    broadcast: host.emit,
    // Badge rendering is the only omitted behavior; its attention state remains.
    applyBadge: () => {},
  });
  const hidden = createHiddenSessionRegistry({ currentDb: host.database, logger: host.log });
  await hidden.ensureHiddenSessionRegistryLoaded();
  const identity = createAgentIslandCompanionIdentity({ getDbClient: host.database.getDbClient,
    resolveSafe: host.resolveMedia, resourcesDirectory: runtimeResourcesDirectory });
  const runtime = createAgentIslandRuntime<AgentIslandWindow, TaskInvocationContext>({
    ...host, ...identity, ipcMain,
    getActiveAppSession: () => ({ dataOwnerId: host.current() ? owner.userId : null, generation: owner.clientEpoch }),
    throwIpcError: (code, message) => { throw Object.assign(new Error(message), { code }); },
    getSessionRowSnapshot: async id => { const row = await host.conversations.snapshot.getSessionRowSnapshot(id); if (!host.current()) throw new Error('TASK_OWNER_CHANGED'); return row; },
    setAgentIslandCompanionChangeSink: sink => { companionSink = sink; },
    clearAppBadgeSessionAttention: attention.clearSessionAttention,
    hasAppBadgeSessionAttention: attention.hasSessionAttention,
    tapWindowBroadcast: host.emit,
    createLocalizedToolRowWording: () => createLocalizedToolRowWording(host.t),
  });
  service = runtime.initAgentIslandService({ getMainWindow: () => null,
    isCompletionHandledByTeammate: host.isCompletionHandledByTeammate,
    onSessionActivityChange: list => host.emit(AGENT_ISLAND_SESSION_SNAPSHOTS_CHANNEL, list) })!;
  attention.initAppBadgeService({ getWindow: () => null,
    onSessionAttentionMarked: id => service.handleSessionAttentionMarked(id),
    onSessionAttentionCleared: (id, source) => service.handleSessionAttentionCleared(id, source) });
  const bridge = createSessionActivityBridge({ ...host,
    getAgentIslandService: () => service, isSessionHiddenSync: hidden.isSessionHiddenSync });
  return {
    service, bridge, attention, identity, hidden,
    channels: [...handlers.keys()],
    invoke(channel: string, args: unknown[], context: TaskInvocationContext) {
      host.assertTrustedAppRendererEvent(context);
      const handler = handlers.get(channel);
      if (!handler) throw new Error('UNKNOWN_SESSION_ACTIVITY_CHANNEL');
      return handler(context, ...args);
    },
    metadata(id: string, patch: { status?: unknown; hiddenAt?: unknown; title?: unknown; workingDir?: unknown; workspaceKind?: unknown }) {
      if (!host.current()) return;
      if ('hiddenAt' in patch) hidden.noteSessionHidden(id, patch.hiddenAt !== null && patch.hiddenAt !== undefined);
      if (patch.status === 'deleted' || patch.status === 'archived' || (patch.hiddenAt !== null && patch.hiddenAt !== undefined)) {
        service.handleSessionClosed(id); return;
      }
      const nullable = (value: unknown) => value === null || typeof value === 'string' ? value : undefined;
      service.handleSessionMetadataPatch(id, { title: nullable(patch.title), workingDir: nullable(patch.workingDir), workspaceKind: nullable(patch.workspaceKind) });
    },
    hostInteraction(channel: string, payload: unknown) {
      const value = payload as { sessionId?: string; requestId?: string; request?: {
        kind?: string; requestId: string; terminal?: boolean; purpose?: string;
        ghost?: { name: string }; steps?: Array<{ phase: string; title: string }>;
      } } | null;
      if (!host.current() || !value?.sessionId) return;
      if (channel === 'maker:interaction-dismissed' && value.requestId) {
        service.handleInteractionDismissed(value.sessionId, value.requestId); return;
      }
      const request = value.request;
      if (channel !== 'maker:interaction-request' || !request || !['plugin_setup', 'input_handoff'].includes(request.kind ?? '')
        || !bridge.shouldNotifyAgentIslandForSession(value.sessionId)) return;
      if (request.terminal) { service.handleInteractionDismissed(value.sessionId, request.requestId); return; }
      const detail = request.kind === 'input_handoff' ? request.purpose ?? ''
        : request.steps?.find(step => step.phase !== 'satisfied' && step.phase !== 'cancelled')?.title
          ?? host.t('newChat.pluginSetup.title').replace('{{name}}', request.ghost?.name ?? '');
      service.handlePluginSetupInteraction(value.sessionId, request.requestId, detail, request.kind as 'plugin_setup' | 'input_handoff');
    },
    companionChanged(id: string) { companionSink?.companionChanged(id); },
    groupChanged(id: string) { companionSink?.groupChanged(id); },
    close() { service.resetRuntimeState(); attention.clearAllSessionAttention(); },
  };
}
