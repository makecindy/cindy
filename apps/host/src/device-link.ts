/** Node assembly of the existing Device Link host. Identity, admission, replay,
 * visibility and revocation remain in the same dispatcher as desktop. */
import os from 'node:os';
import { requestPluginOauth, invalidatePluginOauth, supportsRemotePluginOauth } from '../../desktop/src/main/plugin-oauth/runtime.js';
import WebSocket from 'ws';
import { CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, DeviceLinkClient, RoutedDeviceLinkClient, type DeviceLinkClientOptions, type LinkAcceptPayload } from '@cindy/device-link';
import { createAgentNetNode, type AgentNetNodePorts } from '../../desktop/src/main/device-link/agentNetNode.js';
import { AgentNetSessionLinks, agentNetSessionLane, routeSessionPeers, type PeerLinks } from '@cindy/agent-net';
import { HOST_CONTRACT_CHANNELS } from '@cindy/maker-shared/host-channel-contract';
import type { TaskTagRequest } from '@cindy/maker-shared';
import { createInboundDispatch, type InboundDispatchPorts } from '../../desktop/src/main/device-link/dispatch.js';
import { createInvokeRegistry } from '../../desktop/src/main/device-link/invokeRegistryCore.js';
import { toLegacyUsdModelPricing } from '../../desktop/src/main/maker-ipc/usageHandlers.js';
import { createDeviceLinkSettingsStore } from '../../desktop/src/main/device-link/settings-store.js';
import { createRemoteControlAccess } from '../../desktop/src/main/device-link/remoteControlAccessCore.js';
import { createAvailabilityPolicy } from '../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import * as botBoundary from '../../desktop/src/main/device-link/remoteBotSessionBoundary.js';
import * as sharedTasks from '../../desktop/src/main/device-link/sharedTaskDispatch.js';
import { admitSharedTaskFsWatchTopics } from '../../desktop/src/main/device-link/sharedTaskFileAccess.js';
import * as broadcastTap from '../../desktop/src/main/device-link/broadcast-tap.js';
import { withoutPhaseOneUsagePushes } from './agent/usage-push-channels.js';
import { PROJECT_ARCHIVE_CHANNEL } from '../../desktop/src/shared/projectArchive.js';
import { runProjectArchive } from '../../desktop/src/main/localDb/projectArchive.js';
import { getDbClient } from '../../desktop/src/main/localDb/client/current.js';
import { withSendToSessionLock } from '../../desktop/src/main/maker-ipc/sendToSessionLock.js';
import { TASK_TAG_CHANNEL } from '../../desktop/src/main/localDb/ipc/taskTagService.js';
import { readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch } from '../../desktop/src/main/localDb/ipc/botRemoteSessionAccess.js';
import { createInteractionProjection, projectInteractionDismissedForRemote } from '../../desktop/src/main/cindy-brain/interactionProjection.js';
import { RECOVERY_CHECKPOINT_MARKER } from '../../desktop/src/main/maker-ipc/recoveryMarker.js';
import { checkRemoteWorkingDir, remoteWorkingDirRejectionToIpcError } from '../../desktop/src/main/device-link/remote-workdir-guard.js';
import { desktopTransferCodec } from '../../desktop/src/main/device-link/transferCodec.js';
import { clearControllerPlatforms, setControllerPlatform } from '../../desktop/src/main/device-link/controllerPlatform.js';
import { createHostWebSocketAgent } from './outbound.mjs';
import { createDnsFallbackLookup } from '../../desktop/src/main/device-link/dnsFallbackLookup.js';
import { createLogger } from '../../desktop/src/main/logger.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../desktop/src/main/appSessionState.js';
import { MAKER_INVOKE, MAKER_PUSH } from '../../desktop/src/main/maker-ipc/channels.js';
import { MCP_APPS_INVOKE } from '../../desktop/src/shared/mcpApps.js';
import { deviceLinkInvokeControllerSupports, getDeviceLinkInvokeContext, readDeviceLinkModelSelectionOrigin } from '../../desktop/src/main/device-link/invoke-context.js';
import { explicitPorts } from './agent/explicit-ports.js';

/**
 * What each port the Host hands the shared inbound dispatch (dispatch.ts InboundDispatchPorts) can do
 * while a desktop uses this profile (coexistence plan A, reviewer 2026-11-17):
 * - `read`: reads, or changes only this process's memory (controller access generations, the broadcast
 *   tap, pending plugin authorizations); nothing in the profile is written.
 * - `service-gate`: reaches the Host service, whose gate refuses writes while held (service.mjs).
 * - `refused-at-entry`: writes without the service, so refused here (refuseWhileHeld below).
 * - `unbound`: not passed; the dispatcher answers NOT_SUPPORTED or skips it (dispatch.ts `unavailable`).
 * A port that is not listed here, or is bound against its entry, stops the Host device link from
 * starting; the list is pinned in device-link.test.mjs.
 */
export const HOST_DISPATCH_PORTS_WHILE_HELD = Object.freeze({
  sameAccountCapabilities: 'read',
  readUsageWidgetSnapshot: 'unbound',
  configureStandbyGuestCleanup: 'unbound',
  prepareShareAvailability: 'unbound',
  readKimiCodingAccountUsage: 'unbound',
  readOpenCodeGoAccountUsage: 'unbound',
  // `/api/task-tags/execute`, refused by the service gate while held.
  executeTaskTags: 'service-gate',
  TASK_TAG_CHANNEL: 'read',
  requestFilePeer: 'unbound',
  stopFilePeers: 'unbound',
  requestTaskMigration: 'unbound',
  delegatedProviderShareGuestAccess: 'unbound',
  locallyProvenProviderShareDelegation: 'unbound',
  delegatedProviderShareLeases: 'unbound',
  invalidateProviderShareDelegation: 'unbound',
  app: 'read',
  remoteDesktop: 'unbound',
  requestRemoteDesktop: 'unbound',
  remoteCredentialHost: 'unbound',
  readDeviceLinkSettings: 'read',
  // remoteControlAccessCore.ts: generation counters and the observed-revocation set, in memory.
  noteControllerAccessAllowed: 'read',
  noteControllerAccessDenied: 'read',
  syncRemoteControlAccessGeneration: 'read',
  requestPluginOauth: 'refused-at-entry',
  // Cancels pending authorizations in memory only (plugin-oauth/runtime.ts invalidatePluginOauth,
  // transactions.ts cancelPeer, authentication.ts invalidate); nothing stored is deleted.
  invalidatePluginOauth: 'read',
  // The invoke registry: contract channels call the service (gated); maker:create-session and
  // MCP_APPS_INVOKE are refused where they are registered.
  dispatchLocalInvoke: 'service-gate',
  assertRemoteBotInvocationAllowed: 'read',
  projectRemoteSessionResult: 'read',
  projectRemoteBotPush: 'read',
  hasRemoteBotSessionLookup: 'read',
  setRemoteBotSessionLookup: 'read',
  // No shared-task host is set on the Host (setSharedTaskDispatchHost), so these answer "unavailable".
  captureSharedTaskPeer: 'read',
  captureSharedTaskPush: 'read',
  assertSharedTaskInvoke: 'read',
  sharedTaskMetadataTopic: 'read',
  sharedTaskAccessFailure: 'read',
  fetchLocalMediaToOss: 'unbound',
  MAX_SHARED_TASK_TOPICS: 'read',
  refreshSharedTaskPeer: 'read',
  releaseSharedTaskWatchesOnWorkdirChange: 'read',
  admitSharedTaskFsWatchTopics: 'read',
  transcribeRemoteVoiceInput: 'unbound',
  readTelegramRemoteStatus: 'unbound',
  setTelegramRemoteOnline: 'unbound',
  adviseAndRecordVoiceInputDictionaryLearning: 'unbound',
  buildMobileDictionarySnapshot: 'unbound',
  setBroadcastTapListener: 'read',
  broadcastTap: 'read',
  RECOVERY_CHECKPOINT_MARKER: 'read',
  sanitizeBotAuthorizationMetaForRemote: 'read',
  projectInteractionDismissedForRemote: 'read',
  projectInteractionRequestForRemote: 'read',
  remoteWorkingDirRejectionToIpcError: 'read',
} as const satisfies Record<keyof InboundDispatchPorts, 'read' | 'service-gate' | 'refused-at-entry' | 'unbound'>);
type UnboundDispatchPort = { [K in keyof typeof HOST_DISPATCH_PORTS_WHILE_HELD]:
  (typeof HOST_DISPATCH_PORTS_WHILE_HELD)[K] extends 'unbound' ? K : never }[keyof typeof HOST_DISPATCH_PORTS_WHILE_HELD];

function assertDispatchPortsClassified(ports: object): void {
  const kinds: Record<string, string> = HOST_DISPATCH_PORTS_WHILE_HELD;
  const wrong = Object.entries(ports).filter(([name, value]) => !Object.hasOwn(kinds, name)
    || (kinds[name] === 'unbound') !== (value === undefined)).map(([name]) => name);
  if (wrong.length) throw new Error(`Host dispatch ports without a matching hold class: ${wrong.join(', ')}`);
}
import { normalizeDeviceLinkSetModelWireArgs } from '../../desktop/src/main/maker-ipc/setModelWireArgs.js';

type ServiceResult = { status: number; body: any };
/** How long a connection waits for this Host's stored Agent-Net identity (the signed transport statement) at most. */
const TRANSPORT_STATEMENT_WAIT_MS = 2_000;
export interface HostDeviceLinkPorts {
  profileDir: string;
  version: string;
  getWsUrl(): string;
  getToken(): Promise<string | null>;
  canRegister(): boolean;
  refreshToken?(): Promise<void>;
  invoke(path: string, body?: any, context?: { caller: string }): Promise<ServiceResult>;
  releaseAuthCaller?(caller: string): void;
  isBusyForProjectArchive(sessionId: string): boolean;
  onProjectTaskStatus(sessionId: string, status: 'active' | 'archived'): void;
  preparePiSkillRuntime(id: string, workingDir: string, route?: { model: string; nextInputChars?: number }): Promise<void>;
  createRuntimeSession(input: unknown): Promise<unknown>;
  /** Coexistence plan A: the refusal while a desktop uses this profile, or null. */
  profileHold?(): string | null;
  /** The remote plugin OAuth entry; the desktop's plugin-oauth runtime unless a test passes its own. */
  requestPluginOauth?(peer: string, raw: unknown): Promise<unknown>;
  /** Cancels a peer's (or every) pending plugin authorization in memory; the runtime's unless a test passes its own. */
  invalidatePluginOauth?(peer?: string): void;
  subscribe(listener: (event: any) => void): () => void;
  // Cloud revocation is required before narrowing a persisted standby grant.
  availabilityPolicy?: ReturnType<typeof createAvailabilityPolicy>;
  disableShareAvailability(shareId: string): Promise<void>;
  createWebSocket?: ConstructorParameters<typeof DeviceLinkClient>[0]['createWebSocket'];
  mcpApps?: {
    invoke(caller: string, sessionId: string, input: unknown): Promise<unknown>;
    releaseCaller(caller: string): Promise<void>;
  };
  /**
   * Agent-Net (docs/agent-net-session-plan.md 阶段 5): this Host's identity and node on the account's official network.
   * Its 「Agent-Net (Beta)」 setting lives in the same settings file as the Desktop's and is off by default; while it is off
   * nothing here changes the Device Link client's behaviour.
   */
  agentNet?: Omit<AgentNetNodePorts, 'enabled' | 'current'>;
}

export function createHostDeviceLink(deps: HostDeviceLinkPorts) {
  const log = createLogger('host-device-link');
  const policy = deps.availabilityPolicy ?? createAvailabilityPolicy(deps.disableShareAvailability);
  const settings = createDeviceLinkSettingsStore({ getUserDataDir: () => deps.profileDir, ...policy });
  const access = createRemoteControlAccess(settings);
  const registry = createInvokeRegistry();
  const pending = new Set<Promise<unknown>>();
  const appCallers = new Set<string>();
  function releaseApps(ids: Iterable<string> = appCallers) {
    return Promise.all([...ids].map(async id => {
      appCallers.delete(id);
      deps.releaseAuthCaller?.(`device:${id}`);
      await deps.mcpApps?.releaseCaller(`device:${id}`);
    }));
  }
  function releaseAppsInBackground(ids?: Iterable<string>) {
    const work = releaseApps(ids).catch(() => { log.warn('MCP App controller cleanup failed'); });
    pending.add(work); void work.finally(() => pending.delete(work));
  }
  let closed = false;
  let issue: string | null = null;
  const owner = activeOwnerScopeKey();
  const current = () => !closed && activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
  const assertCurrent = () => { if (!current()) throw new Error('[NOT_FOUND] Host account changed'); };
  const call = async (path: string, body?: any) => {
    assertCurrent();
    const source = getDeviceLinkInvokeContext();
    // The dispatcher has already admitted the channel. Authentication mutations
    // remain owner-only and use the actual controller, never a payload identity.
    const context = source && !source.sharedTask ? { caller: `device:${source.controllerDeviceId}` } : undefined;
    if (context) appCallers.add(source!.controllerDeviceId);
    const result = await deps.invoke(path, body, context);
    assertCurrent();
    if (result.status >= 400) throw new Error(result.body?.message ?? result.body?.error ?? 'Host operation failed');
    return result.body;
  };
  for (const contract of HOST_CONTRACT_CHANNELS) {
    registry.register(contract.desktopChannel, async args => {
      const result = await call(contract.hostPath, contract.body?.(args) ?? {});
      return contract.map ? contract.map(result) : result;
    });
  }
  // The desktop answers `maker:usage:model-pricing` (device-link v1) with the flat USD projection and
  // `-v2` with the native quotes (usageHandlers.ts). Both contract entries share one Host path, which
  // answers v2 for the renderer; v2 is not on the device-link allowlist, so v1 is projected here.
  registry.register('maker:usage:model-pricing', async () => toLegacyUsdModelPricing(await call('/api/usage/model-pricing', {})));
  // Coexistence plan A: while a desktop uses this profile, a new task's runtime and a plugin page's
  // calls (they write through the plugin) are refused, as the service refuses other writes.
  const refuseWhileHeld = () => {
    const held = deps.profileHold?.();
    if (held) throw Object.assign(new Error(`[PRECONDITION_FAILED] ${held}`), { code: 'PRECONDITION_FAILED' });
  };
  registry.register('maker:create-session', ([input]) => { refuseWhileHeld(); return deps.createRuntimeSession(input); });
  registry.register(PROJECT_ARCHIVE_CHANNEL, ([input]) => {
    // The preview is a read. Like project-info writes at the service boundary,
    // apply is refused on entry and rechecked at the write boundary after waiting.
    if ((input as { operation?: unknown } | null)?.operation === 'apply') refuseWhileHeld();
    return runProjectArchive(input, true, {
      withLock: withSendToSessionLock,
      busy: deps.isBusyForProjectArchive,
      write: async (sessionId, status, beforeWrite, projectGuard) => {
        beforeWrite();
        assertCurrent();
        refuseWhileHeld();
        const client = getDbClient();
        if (status === 'archived') {
          await client.tx('sessions.setTerminalStatus', { sessionId, status, projectGuard });
        } else {
          await client.tx('sessions.setStatus', { sessionIds: [sessionId], status, projectGuard });
        }
        assertCurrent();
        deps.onProjectTaskStatus(sessionId, status);
      },
    });
  });
  registry.register(MAKER_INVOKE.SET_MODEL, async ([sessionId, model, wireProviderId, revision, wireSelection]) => {
    const { providerId, selection } = normalizeDeviceLinkSetModelWireArgs(true,
      deviceLinkInvokeControllerSupports(CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1),
      wireProviderId, revision, wireSelection);
    if (selection && typeof selection === 'object' && 'confirmedContextWindow' in selection) {
      throw new Error('[PRECONDITION_FAILED] remote model-window confirmation is unsupported');
    }
    if (readDeviceLinkModelSelectionOrigin() !== 'owner') {
      throw new Error('[PRECONDITION_FAILED] remote model selection requires an owner controller');
    }
    if (typeof model !== 'string' || (providerId !== undefined && providerId !== null && typeof providerId !== 'string')) {
      throw new Error('[INVALID_PARAMS] invalid model or provider');
    }
    const result = await call('/api/sessions/set-model', { sessionId, model, providerId, revision, selection });
    if (result && typeof result === 'object') dispatch.markRemoteSettingPersistedInsideHandler(result);
    return result;
  });
  registry.register(MAKER_INVOKE.SWITCH_SESSION_AGENT, ([sessionId, targetAgentKind, model, providerId, effort, fastMode, options, thinking]) => {
    if (options && typeof options === 'object') {
      if ('confirmedContextWindow' in options) {
        throw new Error('[PRECONDITION_FAILED] remote model-window confirmation is unsupported');
      }
      if ('agentDeviceId' in options) throw new Error('[UNSUPPORTED_CAPABILITY] Host does not yet support remote execution');
    }
    if (typeof model !== 'string' || !model.trim() ||
        (providerId !== null && providerId !== undefined && typeof providerId !== 'string')) {
      throw new Error('[INVALID_PARAMS] invalid model or provider');
    }
    if (readDeviceLinkModelSelectionOrigin() !== 'owner') {
      throw new Error('[PRECONDITION_FAILED] remote agent switching requires an owner controller');
    }
    return call('/api/sessions/switch-agent', { sessionId, targetAgentKind, model, providerId, effort, fastMode,
      options, thinking });
  });
  registry.register(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, ([sessionId]) =>
    call('/api/sessions/agent-switch-intent', { sessionId }));
  registry.register('maker:session:prewarm', async ([id, input]) => {
    assertCurrent();
    if (readDeviceLinkModelSelectionOrigin() !== 'owner') throw new Error('[PRECONDITION_FAILED] Task owner required');
    const request = input as { purpose?: string; workingDir?: string; pendingPiRoute?: unknown; model?: unknown } | null;
    if (request?.purpose !== 'pi-skill-dispatch') return { accepted: false };
    refuseWhileHeld();
    if (typeof id !== 'string' || !id || typeof request.workingDir !== 'string' || !request.workingDir)
      throw new Error('[INVALID_PARAMS] Session and working directory required');
    const pending = request.pendingPiRoute;
    if ('confirmedContextWindow' in request || (pending && typeof pending === 'object' && 'confirmedContextWindow' in pending)) {
      throw new Error('[PRECONDITION_FAILED] remote model-window confirmation is unsupported');
    }
    if (pending !== undefined && (!pending || typeof pending !== 'object' || Array.isArray(pending)
      || ('agentDeviceId' in pending && pending.agentDeviceId != null)
      || typeof request.model !== 'string' || !request.model)) throw new Error('[INVALID_PARAMS] Unsupported Pi route');
    const nextInputChars = pending && typeof pending === 'object' && 'nextInputChars' in pending
      ? pending.nextInputChars : undefined;
    if (nextInputChars !== undefined && (typeof nextInputChars !== 'number' || !Number.isSafeInteger(nextInputChars) || nextInputChars < 0)) {
      throw new Error('[INVALID_PARAMS] Invalid next input size');
    }
    const route = pending !== undefined
      ? { model: request.model as string, ...(nextInputChars !== undefined ? { nextInputChars } : {}) }
      : undefined;
    await deps.preparePiSkillRuntime(id, request.workingDir, route);
    refuseWhileHeld();
    assertCurrent();
    return { accepted: true, piRuntimePrepared: true, ...(route ? { pendingRouteApplied: true } : {}) };
  });
  if (deps.mcpApps) registry.register(MCP_APPS_INVOKE, async ([sessionId, input]) => {
    refuseWhileHeld();
    const source = getDeviceLinkInvokeContext();
    if (!source || source.sharedTask) throw new Error('[PRECONDITION_FAILED] MCP_APP_OWNER_ONLY');
    if (typeof sessionId !== 'string' || (input && typeof input === 'object' && 'deviceId' in input))
      throw new Error('[INVALID_PARAMS] MCP_APP_INVALID_REQUEST');
    appCallers.add(source.controllerDeviceId);
    return deps.mcpApps!.invoke(`device:${source.controllerDeviceId}`, sessionId, input);
  });
  const invoke = async (channel: string, args: unknown[]) => {
    assertCurrent();
    const work = registry.dispatch(channel, args);
    pending.add(work);
    try { const result = await work; assertCurrent(); return result; }
    finally { pending.delete(work); }
  };
  const cancelPluginOauth = deps.invalidatePluginOauth ?? invalidatePluginOauth;
  const tags = { executeTaskTags: (request: TaskTagRequest) =>
    call('/api/task-tags/execute', { request }) };
  /** This Host runs on Agent-Net right now (set once the node exists, below). */
  let agentNetActive = (): boolean => false;
  const unboundPorts = Object.fromEntries(Object.entries(HOST_DISPATCH_PORTS_WHILE_HELD)
    .filter(([, kind]) => kind === 'unbound').map(([name]) => [name, undefined]));
  const interactions = createInteractionProjection(supportsRemotePluginOauth);
  const dispatchPorts = explicitPorts<InboundDispatchPorts>({
    ...(unboundPorts as Record<UnboundDispatchPort, undefined>),
    // Platform capabilities are added only when their backing services are wired. Background links need none: this
    // dispatch already keeps a link that declares no subscriptions out of the controlled state. Without it a desktop
    // closes every background link it opens here (backgroundLink.ts) and opens the next one for its next read; on
    // Agent-Net that is a session link reopened per read. Only while Agent-Net is on: off, the Host answers as before.
    sameAccountCapabilities: () => (agentNetActive() ? [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] : []),
    app: { getVersion: () => deps.version },
    ...tags, TASK_TAG_CHANNEL,
    readDeviceLinkSettings: () => ({ ...settings.readDeviceLinkSettings(), remoteControlEnabled: current() && settings.readDeviceLinkSettings().remoteControlEnabled }),
    noteControllerAccessAllowed: access.noteControllerAccessAllowed,
    noteControllerAccessDenied: access.noteControllerAccessDenied,
    syncRemoteControlAccessGeneration: access.syncRemoteControlAccessGeneration,
    dispatchLocalInvoke: invoke,
    assertRemoteBotInvocationAllowed: botBoundary.assertRemoteBotInvocationAllowed,
    projectRemoteSessionResult: botBoundary.projectRemoteSessionResult,
    projectRemoteBotPush: botBoundary.projectRemoteBotPush,
    hasRemoteBotSessionLookup: botBoundary.hasRemoteBotSessionLookup,
    setRemoteBotSessionLookup: botBoundary.setRemoteBotSessionLookup,
    captureSharedTaskPeer: sharedTasks.captureSharedTaskPeer,
    captureSharedTaskPush: sharedTasks.captureSharedTaskPush,
    assertSharedTaskInvoke: sharedTasks.assertSharedTaskInvoke,
    sharedTaskMetadataTopic: sharedTasks.sharedTaskMetadataTopic,
    sharedTaskAccessFailure: sharedTasks.sharedTaskAccessFailure,
    MAX_SHARED_TASK_TOPICS: sharedTasks.MAX_SHARED_TASK_TOPICS,
    refreshSharedTaskPeer: sharedTasks.refreshSharedTaskPeer,
    releaseSharedTaskWatchesOnWorkdirChange: sharedTasks.releaseSharedTaskWatchesOnWorkdirChange,
    admitSharedTaskFsWatchTopics,
    // Phase 1: the usage pushes are not forwarded to remote devices (agent/usage-push-channels.ts).
    setBroadcastTapListener: (listener: Parameters<typeof broadcastTap.setBroadcastTapListener>[0]) =>
      broadcastTap.setBroadcastTapListener(withoutPhaseOneUsagePushes(listener)),
    broadcastTap,
    // A remote plugin authorization writes the plugin's sign-in on this computer: refused while a
    // desktop uses this profile, as the service refuses other writes (the dispatcher handles this
    // channel itself, PLUGIN_OAUTH_CHANNEL, so the service gate does not see it).
    requestPluginOauth: async (peer: string, raw: unknown) => {
      refuseWhileHeld();
      return (deps.requestPluginOauth ?? requestPluginOauth)(peer, raw);
    },
    invalidatePluginOauth: cancelPluginOauth,
    sanitizeBotAuthorizationMetaForRemote: interactions.sanitizeBotAuthorizationMetaForRemote,
    projectInteractionRequestForRemote: interactions.projectInteractionRequestForRemote,
    projectInteractionDismissedForRemote,
    RECOVERY_CHECKPOINT_MARKER, remoteWorkingDirRejectionToIpcError,
  });
  assertDispatchPortsClassified(dispatchPorts);
  const dispatch = createInboundDispatch(dispatchPorts);
  botBoundary.setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
  dispatch.setRemoteWorkingDirGuard((dir, context) => {
    // SSH needs its own endpoint authority and cannot fall through to local IO.
    if (context?.remoteHostId) return { allowed: false, reason: 'unavailable' };
    return checkRemoteWorkingDir(dir);
  });
  const lookup = createDnsFallbackLookup({ log });
  const relayOptions: DeviceLinkClientOptions = {
    getWsUrl: deps.getWsUrl,
    getToken: async () => {
      if (!current() || !deps.canRegister()) return null;
      if (issue === 'auth-failed') await deps.refreshToken?.();
      return current() && deps.canRegister() ? deps.getToken() : null;
    },
    getHello: () => ({ platform: process.platform, deviceName: process.env.CINDY_HOST_DEVICE_NAME?.trim() || `${os.hostname()} · Cindy Host`,
      appVersion: deps.version, remoteControlEnabled: current() && settings.readDeviceLinkSettings().remoteControlEnabled,
      busy: pending.size > 0, capabilities: [] }),
    transferCodec: desktopTransferCodec,
    peerResetReadRetry: true,
    timing: { pingIntervalMs: 15_000 },
    logger: log,
    createWebSocket: deps.createWebSocket ?? (async (url, headers) => new WebSocket(url, {
      headers, agent: await createHostWebSocketAgent(url), lookup,
    } as WebSocket.ClientOptions)),
  };
  const agentNet = deps.agentNet ? createAgentNetNode({ ...deps.agentNet, current,
    enabled: () => current() && settings.readDeviceLinkSettings().agentNetEnabled === true }) : null;
  if (agentNet) agentNetActive = () => agentNet.active();
  /** The main connection is this Host's Agent-Net node right now (set by `agentNetClient`). */
  let primaryEncrypted = () => false;
  /** The compatibility connection's last problem (Agent-Net on): its 401 refreshes the token as the main connection's does. */
  let compatibilityIssue: string | null = null;
  const compatibility: { watch: ((cb: (value: { kind: string } | null) => void) => () => void) | null } = { watch: null };
  const client: PeerLinks = agentNet ? agentNetClient(agentNet) : new DeviceLinkClient(relayOptions);
  /**
   * The same assembly as the Desktop (apps/desktop/src/main/device-link/index.ts): while Agent-Net is on, the main
   * connection is this Host's Agent-Net node and devices that are not on Agent-Net keep reaching it over the Device Link
   * relay (the legacy route, with the same signed statement of this Host's Agent-Net mode); devices that also run the
   * session layer reach it on sessions. While it is off, the main connection is the relay exactly as before.
   */
  function agentNetClient(node: NonNullable<typeof agentNet>): PeerLinks {
    let encrypted = false;
    primaryEncrypted = () => encrypted;
    const routed = new RoutedDeviceLinkClient({ ...relayOptions,
      reliablePeerTransport: () => encrypted,
      // Off, the main connection is the relay: once this Host has joined Agent-Net its peers know it and accept a relay
      // link only with its signed statement that it is off (the Desktop signs on or off alike), so it signs here too.
      transportAttestation: node.transportAttestation,
      verifyTransportAttestation: (peer, requestId, proof) => encrypted || node.verifyTransportAttestation(peer, requestId, proof),
      getToken: async () => {
        // Bounded: a credential store that hangs (a keyring prompting nobody) must not hold the relay connection; the
        // statement it reads is for peers that know this Host from Agent-Net, a later connection still signs it.
        await Promise.race([node.prepareTransportStatement(), new Promise<void>((resolve) => {
          setTimeout(resolve, TRANSPORT_STATEMENT_WAIT_MS).unref?.();
        })]);
        return node.active() ? (current() && deps.canRegister() ? 'agent-net-local-node' : null) : relayOptions.getToken();
      },
      createWebSocket: async (url, headers) => {
        encrypted = false;
        const socket = await node.openSocket(deps.agentNet!.subject() ?? '');
        if (socket) { encrypted = true; return socket as unknown as WebSocket; }
        return relayOptions.createWebSocket!(url, headers);
      },
    }, undefined, {
      active: () => node.active(),
      useForPeer: node.shouldUseLegacyPeer,
      probeForPeer: node.shouldProbeLegacyPeer,
      primaryCapability: 'agent-net-node-v2',
      prefersPrimary: node.prefersPrimary,
      openOnPrimary: (peer: string, payload: unknown, timeoutMs: number | undefined,
        primary: () => Promise<LinkAcceptPayload>): Promise<LinkAcceptPayload> => sessionLinks.openAttested(peer, payload, timeoutMs, primary),
      options: { ...relayOptions, transportCapabilities: () => (node.active() ? ['agent-net-node-v2'] : []),
        transportAttestation: node.transportAttestation, verifyTransportAttestation: node.verifyTransportAttestation,
        // Its own rejection decides its refresh (`issue` is the main connection's, which runs on the node with no token).
        getToken: async () => {
          if (!current() || !deps.canRegister()) return null;
          if (compatibilityIssue === 'auth-failed') await deps.refreshToken?.();
          return current() && deps.canRegister() ? deps.getToken() : null;
        } },
    });
    compatibility.watch = (cb) => routed.onLegacyConnectionIssue(cb);
    let facade: PeerLinks | null = null;
    const sessionLinks = new AgentNetSessionLinks({
      session: node.session,
      connectionEpoch: (peer): number => (facade ?? routed).connectionFor(peer).getConnectionEpoch(),
      selfDeviceId: () => routed.getSelfDeviceId(),
      transferCodec: desktopTransferCodec,
      path: (peer) => node.route(peer).path,
      rttMs: (peer) => node.route(peer).rttMs,
      connectedAt: node.connectedAt,
      connect: node.connect,
      agentNetPeer: node.agentNetPeer,
      // 链路回复带上这台的请求去重记忆是哪一份，控制端断线后据此判断能不能用原请求号再发（packages/agent-net/src/session/sessionLinks.ts）。
      invokeEpoch: (deviceId) => dispatch.remoteInvokeEpoch(deviceId),
      log,
    });
    node.useSessions({ laneFor: agentNetSessionLane, handlers: (peer) => sessionLinks.handlers(peer) });
    facade = routeSessionPeers(routed, sessionLinks, log);
    return facade;
  }
  // Turning Agent-Net on or off reconnects the main connection: it is opened on the node or on the relay accordingly.
  let agentNetWasActive = agentNet?.active() ?? false;
  const unbind = dispatch.wireInboundDispatch(client);
  const offStatus = client.onStatusChange(status => {
    if (status !== 'online') {
      // Like the Desktop: while Agent-Net is on, controllers carried by another connection (phones and older Desktops on the
      // Device Link relay, cross-account peers on their own) are outside the main connection's fault; 2026-11-17 review: an
      // Agent-Net drop logged every phone out of this Host. Off, every controller as before.
      const keepController = agentNet?.active() ? (id: string) => client.connectionFor(id) !== client : undefined;
      releaseAppsInBackground(keepController ? [...appCallers].filter(id => !keepController(id)) : undefined);
      dispatch.deactivateAllControllers('relay-disconnected', 'all', keepController);
      clearControllerPlatforms();
    } else {
      dispatch.flushMakerEventBatchesOnReconnect();
      dispatch.flushRemoteInvokeResultOutboxOnReconnect();
    }
  });
  let authRecovery: Promise<void> | null = null;
  const offIssue = client.onConnectionIssue(value => {
    issue = value?.kind ?? null;
    // "Removed" from the Agent-Net node is Agent-Net refusing this Host's identity (revoked there), not Device Link's answer: run on
    // the Device Link relay, which decides by itself (as the Desktop, index.ts).
    if (value?.kind === 'device-removed' && agentNet && primaryEncrypted()) {
      agentNet.noteIdentityRefused('relay closed 4410');
      setTimeout(() => { client.stop(); client.start(); }, 0);
    }
    if (value?.kind === 'auth-failed' && current() && deps.refreshToken && !authRecovery) {
      authRecovery = deps.refreshToken().catch(() => { issue = 'auth-failed'; }).finally(() => { authRecovery = null; });
    }
  });
  // Agent-Net on: the compatibility connection (phones and older Desktops) reports its own problems; a 401 there refreshes the
  // token too, and `cindy-host remote status` shows it (2026-11-17: neither happened, phones stayed away without a reason).
  const offCompatibilityIssue = compatibility.watch?.((value) => {
    compatibilityIssue = value?.kind ?? null;
    if (value) log.warn(`compatibility connection issue: ${value.kind}`);
    if (value?.kind === 'auth-failed' && current() && deps.refreshToken && !authRecovery) {
      authRecovery = deps.refreshToken().catch(() => undefined).finally(() => { authRecovery = null; });
    }
  });
  const offPresence = client.onPresenceChanged(value => {
    if (value.online) {
      setControllerPlatform(value.deviceId, value.platform ?? null);
      if (value.deviceName) dispatch.setControllerDisplayName(value.deviceId, value.deviceName);
    } else {
      setControllerPlatform(value.deviceId, null);
      releaseAppsInBackground([value.deviceId]);
      dispatch.handleControllerOffline(value.deviceId);
    }
  });
  const offEvents = deps.subscribe(event => {
    if (!current()) return;
    const scope = broadcastTap.captureDataOwnerBroadcastScope();
    const emit = (channel: string, payload: unknown) => {
      if (current() && broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))
        broadcastTap.tapWindowBroadcast(channel, payload, scope.ownerStamp);
    };
    const id = event.sessionId;
    switch (event.type) {
      case 'task_tags_changed': emit('local-db:task-tags:changed', event.payload); break;
      case 'plugin_push':
        if (['ghosts:changed', 'ghosts:runtime-changed', 'ghosts:card-updated', 'ghosts:notify'].includes(event.channel))
          emit(event.channel, event.payload);
        break;
      case 'interaction_request': emit(MAKER_PUSH.INTERACTION_REQUEST, { sessionId: id, request: event.request }); break;
      case 'interaction_dismissed': emit(MAKER_PUSH.INTERACTION_DISMISSED, { sessionId: id, requestId: event.requestId, reason: event.reason }); break;
      case 'input_projection': emit(MAKER_PUSH.INPUT_PROJECTION, event.projection); break;
      case 'message_created': emit('local-db:messages:created', { sessionId: id, message: event.message }); break;
      case 'project_aliases_changed':
        emit('local-db:project-aliases:changed', {});
        if (event.catalogChanged === true) emit('local-db:recent-workdirs:changed', {});
        break;
      case 'message_deleted': emit('local-db:messages:deleted', event); break;
      case 'error_persisted': emit('local-db:session:error-persisted', { sessionId: id, persistId: event.persistId }); break;
      case 'subagent_runs_changed': emit('local-db:subagent-runs:changed', event); break;
      case 'session_created':
      case 'session_changed':
        if (event.session) emit('local-db:sessions:created', event.session);
        else if (event.type === 'session_created' || event.action === 'create') {
          void call('/api/sessions/get', { sessionId: id }).then(row => emit('local-db:sessions:created', row)).catch(() => {});
        } else if (event.patch || event.status || event.action === 'delete' || event.action === 'discard_provisional') {
          emit('local-db:sessions:patched', { sessionId: id, patch: event.patch ?? { status: event.status ?? 'deleted' } });
        }
        break;
      default:
        if (id && event.event) emit(MAKER_PUSH.EVENT, { sessionId: id, event: event.event,
          persistId: event.persistId, resolvedContent: event.resolvedContent });
    }
  });
  const sync = () => {
    if (!current()) return;
    const value = settings.readDeviceLinkSettings();
    access.syncRemoteControlAccessGeneration();
    for (const id of value.revokedControllers) {
      dispatch.purgeRevokedController(id);
      if (appCallers.has(id)) releaseAppsInBackground([id]);
    }
    if (!value.remoteControlEnabled || !deps.canRegister()) {
      dispatch.dropAllControllers(client, 'toggle-off'); client.stop();
      releaseAppsInBackground();
    } else {
      client.start();
      const agentNetActive = agentNet?.active() ?? false;
      if (agentNetActive !== agentNetWasActive) {
        agentNetWasActive = agentNetActive;
        if (!agentNetActive) agentNet?.close();
        client.restartConnection('agent-net-switch');
      }
    }
  };
  const offSettings = settings.onDeviceLinkSettingChanged(sync);
  // External local edits share the same settings file, just as desktop does.
  const poll = setInterval(sync, 2_000); poll.unref();
  sync();
  return {
    canAuthorize: (peer: string) => current() && client.getStatus() === 'online' && deps.canRegister()
      && settings.readDeviceLinkSettings().remoteControlEnabled && !settings.readDeviceLinkSettings().revokedControllers.includes(peer),
    state: () => ({ enabled: settings.readDeviceLinkSettings().remoteControlEnabled,
      status: client.getStatus(), issue: deps.canRegister() ? issue : 'host-login-required',
      controllers: dispatch.getActiveControllers(),
      ...(agentNet ? { agentNet: { enabled: settings.readDeviceLinkSettings().agentNetEnabled === true, active: agentNet.active(),
        ...(agentNet.active() && compatibilityIssue ? { compatibilityIssue } : {}) } } : {}) }),
    async setEnabled(enabled: boolean) {
      assertCurrent();
      // Turning remote control on writes the profile's device-link settings outside the service gate, so it
      // refuses a held profile as setAgentNetEnabled does: at entry and again inside the settings lock.
      // Turning it off keeps its current path (disable and revoke under a hold are decided separately).
      if (enabled) refuseWhileHeld();
      if (enabled && !deps.canRegister()) throw new Error('Sign in with cindy-host login to register an independent Host device.');
      if (enabled) {
        await settings.updateDeviceLinkSetting('remoteControlEnabled', () => {
          assertCurrent();
          refuseWhileHeld();
          return true;
        });
      } else await settings.writeDeviceLinkSetting('remoteControlEnabled', false);
      sync(); return this.state();
    },
    /** This Host's 「Agent-Net (Beta)」 setting (off by default); the main connection follows it right away. */
    async setAgentNetEnabled(enabled: boolean) {
      assertCurrent();
      refuseWhileHeld();
      if (!agentNet) throw new Error('Agent-Net is not available on this Host.');
      await settings.updateDeviceLinkSetting('agentNetEnabled', () => {
        assertCurrent();
        refuseWhileHeld();
        return enabled;
      });
      sync(); return this.state();
    },
    async revoke(deviceId: string) {
      assertCurrent();
      if (!deviceId || deviceId.length > 256) throw new Error('Invalid controller device ID');
      await settings.updateDeviceLinkSetting('revokedControllers', ids => [...new Set([...ids, deviceId])]);
      access.noteControllerAccessDenied(deviceId); dispatch.purgeRevokedController(deviceId);
      return this.state();
    },
    async stop() {
      if (closed) return;
      closed = true; cancelPluginOauth();
      clearInterval(poll); offSettings(); offEvents(); offPresence(); offIssue(); offCompatibilityIssue?.(); offStatus(); unbind();
      dispatch.dropAllControllers(client, 'shutdown'); client.stop(); agentNet?.close(); registry.clear(); clearControllerPlatforms();
      await releaseApps();
      // Admission is closed before waiting; no handler may write after storage closes.
      await Promise.allSettled([...pending, dispatch.drainInboundExecutions()]);
      botBoundary.setRemoteBotSessionLookup(null);
    },
  };
}
