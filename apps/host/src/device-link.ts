/** Node assembly of the existing Device Link host. Identity, admission, replay,
 * visibility and revocation remain in the same dispatcher as desktop. */
import os from 'node:os';
import { requestPluginOauth, invalidatePluginOauth, supportsRemotePluginOauth } from '../../desktop/src/main/plugin-oauth/runtime.js';
import WebSocket from 'ws';
import { DeviceLinkClient } from '@cindy/device-link';
import { HOST_CONTRACT_CHANNELS } from '@cindy/maker-shared/host-channel-contract';
import type { TaskTagRequest } from '@cindy/maker-shared';
import { createInboundDispatch } from '../../desktop/src/main/device-link/dispatch.js';
import { createInvokeRegistry } from '../../desktop/src/main/device-link/invokeRegistryCore.js';
import { createDeviceLinkSettingsStore } from '../../desktop/src/main/device-link/settings-store.js';
import { createRemoteControlAccess } from '../../desktop/src/main/device-link/remoteControlAccessCore.js';
import { createAvailabilityPolicy } from '../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import * as botBoundary from '../../desktop/src/main/device-link/remoteBotSessionBoundary.js';
import * as sharedTasks from '../../desktop/src/main/device-link/sharedTaskDispatch.js';
import { admitSharedTaskFsWatchTopics } from '../../desktop/src/main/device-link/sharedTaskFileAccess.js';
import * as broadcastTap from '../../desktop/src/main/device-link/broadcast-tap.js';
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
import { MAKER_PUSH } from '../../desktop/src/main/maker-ipc/channels.js';
import { MCP_APPS_INVOKE } from '../../desktop/src/shared/mcpApps.js';
import { getDeviceLinkInvokeContext } from '../../desktop/src/main/device-link/invoke-context.js';

type ServiceResult = { status: number; body: any };
export interface HostDeviceLinkPorts {
  profileDir: string;
  version: string;
  getWsUrl(): string;
  getToken(): Promise<string | null>;
  canRegister(): boolean;
  refreshToken?(): Promise<void>;
  invoke(path: string, body?: any, context?: { caller: string }): Promise<ServiceResult>;
  releaseAuthCaller?(caller: string): void;
  createRuntimeSession(input: unknown): Promise<unknown>;
  subscribe(listener: (event: any) => void): () => void;
  // Cloud revocation is required before narrowing a persisted standby grant.
  availabilityPolicy?: ReturnType<typeof createAvailabilityPolicy>;
  disableShareAvailability(shareId: string): Promise<void>;
  createWebSocket?: ConstructorParameters<typeof DeviceLinkClient>[0]['createWebSocket'];
  mcpApps?: {
    invoke(caller: string, sessionId: string, input: unknown): Promise<unknown>;
    releaseCaller(caller: string): Promise<void>;
  };
}

export function createHostDeviceLink(deps: HostDeviceLinkPorts) {
  const log = createLogger('host-device-link');
  const policy = deps.availabilityPolicy ?? createAvailabilityPolicy(deps.disableShareAvailability);
  const settings = createDeviceLinkSettingsStore({ getUserDataDir: () => deps.profileDir, ...policy });
  const access = createRemoteControlAccess(settings);
  const registry = createInvokeRegistry();
  const pending = new Set<Promise<unknown>>();
  const appCallers = new Set<string>();
  function releaseApps(deviceId?: string) {
    const ids = deviceId ? [deviceId] : [...appCallers];
    return Promise.all(ids.map(async id => {
      appCallers.delete(id);
      deps.releaseAuthCaller?.(`device:${id}`);
      await deps.mcpApps?.releaseCaller(`device:${id}`);
    }));
  }
  function releaseAppsInBackground(deviceId?: string) {
    const work = releaseApps(deviceId).catch(() => { log.warn('MCP App controller cleanup failed'); });
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
  registry.register('maker:create-session', ([input]) => deps.createRuntimeSession(input));
  if (deps.mcpApps) registry.register(MCP_APPS_INVOKE, async ([sessionId, input]) => {
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
  const tags = { executeTaskTags: (request: TaskTagRequest) =>
    call('/api/task-tags/execute', { request }) };
  const dispatch = createInboundDispatch({
    // Platform capabilities are added only when their backing services are wired.
    sameAccountCapabilities: () => [],
    app: { getVersion: () => deps.version },
    ...tags, TASK_TAG_CHANNEL, ...settings, ...access,
    readDeviceLinkSettings: () => ({ ...settings.readDeviceLinkSettings(), remoteControlEnabled: current() && settings.readDeviceLinkSettings().remoteControlEnabled }),
    dispatchLocalInvoke: invoke,
    ...botBoundary, ...sharedTasks, admitSharedTaskFsWatchTopics,
    setBroadcastTapListener: broadcastTap.setBroadcastTapListener, broadcastTap,
    requestPluginOauth, invalidatePluginOauth,
    ...createInteractionProjection(supportsRemotePluginOauth), projectInteractionDismissedForRemote,
    RECOVERY_CHECKPOINT_MARKER, remoteWorkingDirRejectionToIpcError,
  });
  botBoundary.setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
  dispatch.setRemoteWorkingDirGuard((dir, context) => {
    // SSH needs its own endpoint authority and cannot fall through to local IO.
    if (context?.remoteHostId) return { allowed: false, reason: 'unavailable' };
    return checkRemoteWorkingDir(dir);
  });
  const lookup = createDnsFallbackLookup({ log });
  const client = new DeviceLinkClient({
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
  });
  const unbind = dispatch.wireInboundDispatch(client);
  const offStatus = client.onStatusChange(status => {
    if (status !== 'online') {
      releaseAppsInBackground();
      dispatch.deactivateAllControllers('relay-disconnected');
      clearControllerPlatforms();
    } else {
      dispatch.flushMakerEventBatchesOnReconnect();
      dispatch.flushRemoteInvokeResultOutboxOnReconnect();
    }
  });
  let authRecovery: Promise<void> | null = null;
  const offIssue = client.onConnectionIssue(value => {
    issue = value?.kind ?? null;
    if (value?.kind === 'auth-failed' && current() && deps.refreshToken && !authRecovery) {
      authRecovery = deps.refreshToken().catch(() => { issue = 'auth-failed'; }).finally(() => { authRecovery = null; });
    }
  });
  const offPresence = client.onPresenceChanged(value => {
    if (value.online) {
      setControllerPlatform(value.deviceId, value.platform ?? null);
      if (value.deviceName) dispatch.setControllerDisplayName(value.deviceId, value.deviceName);
    } else {
      setControllerPlatform(value.deviceId, null);
      releaseAppsInBackground(value.deviceId);
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
      if (appCallers.has(id)) releaseAppsInBackground(id);
    }
    if (!value.remoteControlEnabled || !deps.canRegister()) {
      dispatch.dropAllControllers(client, 'toggle-off'); client.stop();
      releaseAppsInBackground();
    } else client.start();
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
      controllers: dispatch.getActiveControllers() }),
    async setEnabled(enabled: boolean) {
      assertCurrent();
      if (enabled && !deps.canRegister()) throw new Error('Sign in with cindy-host login to register an independent Host device.');
      await settings.writeDeviceLinkSetting('remoteControlEnabled', enabled);
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
      closed = true; invalidatePluginOauth();
      clearInterval(poll); offSettings(); offEvents(); offPresence(); offIssue(); offStatus(); unbind();
      dispatch.dropAllControllers(client, 'shutdown'); client.stop(); registry.clear(); clearControllerPlatforms();
      await releaseApps();
      // Admission is closed before waiting; no handler may write after storage closes.
      await Promise.allSettled([...pending, dispatch.drainInboundExecutions()]);
      botBoundary.setRemoteBotSessionLookup(null);
    },
  };
}
