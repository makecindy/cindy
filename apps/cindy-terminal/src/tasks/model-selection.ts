import { createTerminalModelContext } from './model-context.js';
import { registerSessionRuntimeAxisHandlers, type SessionRuntimeAxisHost, type SessionRuntimeAxisHandler } from '@cindy/app-runtime/sessionRuntimeAxisHandlers';
import { createPendingCredentialSwitchRegistration, createPendingCredentialSwitchPersistence } from '@cindy/app-runtime/pendingCredentialSwitchHost';
import { createScheduledPreferenceStore } from '@cindy/app-runtime/scheduledPreferenceStore';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseAgent, Logger } from '@cindy/maker-core';
import { createSessionModelSelection } from '@cindy/app-runtime/sessionModelSelection';
import type { SessionModelSelectionHost } from '@cindy/app-runtime/sessionModelSelectionHost';
import { createAgentDeviceRuntimeSelection } from '@cindy/app-runtime/agentDeviceRuntimeSelection';
import { createPendingRuntimeAxisResolver } from '@cindy/app-runtime/pendingRuntimeAxisResolver';
import { createSharedTaskSettingGuard } from '@cindy/app-runtime/sharedTaskSetting';
import type { createSessionRuntimeControl, SessionRuntimeProfile } from '@cindy/app-runtime/sessionRuntimeControl';
import type { createSessionRuntimeAxes } from '@cindy/app-runtime/sessionRuntimeAxes';
import type { ApplySessionRuntimeSelection } from '@cindy/app-runtime/sessionRuntimeSelectionTypes';
import { makerToDbAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { readDeviceProviderViews, type DeviceAgentServiceDeps } from '@cindy/remote-agent';
import type { NodeDatabase } from '../database.js';
import type { TerminalTaskHost, TaskInvocationContext } from './host.js';
import type { TerminalConversations } from './conversations.js';

/** Node supplies native processes and owner-scoped services to the same model
 * transaction used by Desktop. No route/window/persistence state machine lives here. */
export function createTerminalModelSelection(host: {
  tasks: TerminalTaskHost;
  database: NodeDatabase;
  conversations: TerminalConversations;
  control: ReturnType<typeof createSessionRuntimeControl>;
  axes: ReturnType<typeof createSessionRuntimeAxes>;
  log: Logger;
  guard(): void;
  invocation(): TaskInvocationContext;
  remoteInvoke?: DeviceAgentServiceDeps['remoteInvoke'];
  maker: Omit<SessionModelSelectionHost['maker'], 'forkSdkSession' | 'requiresCodexThreadHostTransfer'> & Pick<SessionRuntimeAxisHost['maker'], 'closeSessionIfCurrent'>;
  profileDir: string;
  binaryPath(kind: import('@cindy/maker-core').AgentKind): string | undefined;
  currentOwnerSession(): import('@cindy/app-runtime/providerOwnerGuards').ProviderOwnerSession;
  readSessionRuntimeProfiles: SessionRuntimeAxisHost['readSessionRuntimeProfiles'];
  isSessionInTurn(id: string): boolean;
  createControlAgent(id: string, selection: {model?: string; providerId?: string | null}): Promise<BaseAgent>;
} & Pick<SessionModelSelectionHost, 'wakeSessionInputAfterCredentialSwitch' |
  'withRehydrateCloseSuppressed' | 'getSessionLastLiveUsage' |
  'rehydrateColdPiRuntimeForWindowVerification' | 'getCodexProxyAuthInjectionState' |
  'persistSessionFields' | 'recordSessionContextSnapshot' |
  'listSshCodexProviders' | 'assertModelRouteUsable'>) {
  const {tasks, control, axes, database, conversations} = host;
  const nativeScope = new AsyncLocalStorage<{id: string; agents: Map<string, Promise<BaseAgent>>}>();
  const native = async (selection: {model?: string; providerId?: string | null}) => {
    host.guard();
    const scope = nativeScope.getStore();
    if (!scope) throw new Error('Native model selection scope is unavailable');
    const key = JSON.stringify([selection.model, selection.providerId]);
    let agent = scope.agents.get(key);
    if (!agent) {
      agent = host.createControlAgent(scope.id, selection);
      scope.agents.set(key, agent);
    }
    return agent;
  };
  const getDbClient = () => {host.guard(); return database.getDbClient();};
  const broadcastSessionRuntimeProjection: SessionModelSelectionHost['broadcastSessionRuntimeProjection'] = async (id, baselineOverride) => {
    const row = await tasks.storage.get(id);
    host.guard();
    if (!row) return;
    const baseline: SessionRuntimeProfile = baselineOverride ?? {agentKind: row.agentKind,
      agentDeviceId: row.agentDeviceId ?? null, model: row.model, providerId: row.providerId ?? null,
      effort: row.effort ?? null, fastMode: row.fastMode ?? false};
    conversations.notifications.broadcastSessionPatched(id, control.projectSessionRuntimeControl(id, baseline));
  };
  const providers = {
    getDesktopProviderService: () => ({listProviders: () => tasks.models.views()}),
    getActiveCatalog: () => tasks.models.activeCatalog(),
  };
  const preferences = createScheduledPreferenceStore({getDbClient, broadcastSessionRuntimeProjection, ...providers, resolveSessionRuntimeAxes: control.resolveSessionRuntimeAxes});
  tasks.routes.clearScheduledPreference = id => preferences.updateScheduledPreference(id, null);
  const common = {
    ...control, ...axes, ...tasks.routes.providers, ...tasks.routes.runtime, ...providers,
    log: host.log, getDbClient,
    maker: {...host.maker,
      requiresCodexThreadHostTransfer: async (options: Parameters<SessionModelSelectionHost['maker']['requiresCodexThreadHostTransfer']>[0]) =>
        (await native(options)).requiresCodexThreadHostTransfer(options),
      forkSdkSession: async (kind: Parameters<SessionModelSelectionHost['maker']['forkSdkSession']>[0], options: Parameters<SessionModelSelectionHost['maker']['forkSdkSession']>[1]) => {
        const agent = await native(options);
        if (agent.kind !== kind) throw new Error('Native model selection agent changed');
        return agent.forkSdkSession(options);
      },
    },
    agentSwitchPending: tasks.routes.pending,
    agentSwitchDeps: tasks.routes.deps,
    isDeviceLinkInvoke: () => host.invocation().source === 'remote',
    isSessionInTurn: host.isSessionInTurn,
    wakeSessionInputAfterCredentialSwitch: host.wakeSessionInputAfterCredentialSwitch,
    withRehydrateCloseSuppressed: host.withRehydrateCloseSuppressed,
    persistSessionFields: host.persistSessionFields,
    updateScheduledPreference: preferences.updateScheduledPreference,
    contextOverflowRolloverHolder: tasks.routes.recovery.runtime,
    broadcastSessionPatched: conversations.notifications.broadcastSessionPatched,
    broadcastSessionRuntimeProjection,
  };
  const readUsableAgentDeviceProviders = async (device: string, kind: Parameters<SessionModelSelectionHost['assertModelRouteUsable']>[0], model: string, provider: string | null) => {
    host.guard();
    await tasks.routes.deps.assertAgentDeviceRouteUsable!(device, kind, model, provider);
    if (!host.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
    const result = await readDeviceProviderViews(host.remoteInvoke, device);
    host.guard();
    return result;
  };
  const pendingHost = {...common, pendingCredentialSwitchHolder: tasks.routes.credentials,
    getSessionDbAgentKind: (id: string) => {const row = tasks.storage.peek(id); return row ? makerToDbAgentKind(row.agentKind) : undefined;},
    resolveConfiguredContextWindow: tasks.models.configuredContextWindow};
  const selectionHost: SessionModelSelectionHost = {
    ...common,
    persistsLocalModelSelection: true,
    deviceLinkInvokeControllerSupports: capability => host.invocation().controllerCapabilities?.includes(capability) === true,
    captureSharedTaskSettingGuard: id => {
      const invocation = host.invocation();
      if (invocation.sharedTask && !invocation.sharedTaskCapture) throw new Error('SHARED_TASK_REVALIDATION_REQUIRED');
      return createSharedTaskSettingGuard(invocation.sharedTaskCapture, id, {admitted: false});
    },
    assertReviewSettingsUnlocked: async id => {
      const row = await tasks.storage.get(id); host.guard();
      if (row?.source === 'review') throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
    },
    getCurrentDbClientSnapshot: database.getCurrentDbClientSnapshot,
    canApplyAutomaticRuntimeSelection: (id, generation) => !tasks.routes.pending.get(id) && control.sessionRuntimeGenerationMatches(id, generation),
    applyAgentDeviceRuntimeSelection: createAgentDeviceRuntimeSelection({...common, readUsableAgentDeviceProviders,
      assertAgentDeviceRouteUsable: async (...args) => {await readUsableAgentDeviceProviders(...args);}}),
    listSshCodexProviders: host.listSshCodexProviders,
    getSessionDbAgentKind: id => {const row = tasks.storage.peek(id); return row ? makerToDbAgentKind(row.agentKind) : undefined;},
    assertModelRouteUsable: host.assertModelRouteUsable,
    clearPendingCredentialSwitchForSession: (id, options) => {
      tasks.routes.credentials.clear(id);
      if (options?.wake !== false) host.wakeSessionInputAfterCredentialSwitch(id);
    },
    registerPendingCredentialSwitchForSession: createPendingCredentialSwitchRegistration(pendingHost),
    resolvePendingRuntimeAxisPatch: createPendingRuntimeAxisResolver({...control, ...providers, log: host.log}),
    getPendingCredentialSwitchTarget: id => tasks.routes.credentials.get(id),
    pendingCredentialSwitchHolder: tasks.routes.credentials,
    getSessionLastLiveUsage: host.getSessionLastLiveUsage,
    resolveConfiguredContextWindow: tasks.models.configuredContextWindow,
    rehydrateColdPiRuntimeForWindowVerification: host.rehydrateColdPiRuntimeForWindowVerification,
    ...conversations.broadcastTap,
    getCodexProxyAuthInjectionState: host.getCodexProxyAuthInjectionState,
    recordSessionContextSnapshot: host.recordSessionContextSnapshot,
    withSendToSessionLock: (id, run) => tasks.routes.withLock(id, run),
  };
  const service = createSessionModelSelection(selectionHost);
  const axesHandlers = new Map<string, SessionRuntimeAxisHandler>();
  registerSessionRuntimeAxisHandlers({handle: (channel, handler) => {axesHandlers.set(channel, handler);}}, {
    ...selectionHost, ...control, ...preferences,
    maker: host.maker,
    // Terminal has no Desktop subscription/group policy store. Model
    // capabilities remain authoritative; this host policy simply permits the
    // runtime-axis handler to reach that normal capability check.
    createSubscriptionFastPolicy: () => ({ isAllowed: () => true }),
    assertTrustedAppRendererEvent: () => host.guard(),
    readUsableAgentDeviceProviders,
    readSessionRuntimeProfiles: host.readSessionRuntimeProfiles,
  });
  const setRuntimeAxis = (channel: string, id: unknown, value: unknown) => {
    const handler = axesHandlers.get(channel);
    if (!handler) throw new Error('Runtime axis handler is unavailable');
    return handler(undefined, id, value);
  };
  const handle: typeof service = async (...args) => {
    const id = args[0];
    if (typeof id !== 'string') return service(...args);
    const scope = {id, agents: new Map<string, Promise<BaseAgent>>()};
    return nativeScope.run(scope, async () => {
      try {return await service(...args);}
      finally {
        const results = await Promise.allSettled([...scope.agents.values()].map(async agent => (await agent).dispose()));
        for (const result of results) if (result.status === 'rejected') host.log.warn('Model selection native cleanup failed', {error: String(result.reason)});
      }
    });
  };
  const configureModelContext = createTerminalModelContext({...host, models: tasks.models,
    refresh: targets => tasks.routes.runtime.refreshActiveModelContextSettings({
      targets,
      inferProviderId: (model, kind) => tasks.models.contextProvider(kind, null, model),
      assertCurrent: host.guard,
      hasPendingSelection: id => {const pending = control.getPendingSessionRuntimeMutation(id); return !!tasks.routes.pending.get(id) || !!pending && control.isPendingSessionRuntimeRouteExplicit(id, pending.generation);},
      withSessionLock: (id, run) => tasks.routes.withLock(id, run),
      applyPiRefresh: async (id, model, provider) => {
        const result = await handle(id, model, provider, undefined, undefined, {source: 'agent', sessionLockHeld: true,
          applyingUserSelectionOnSend: true, expectedGeneration: control.getSessionRuntimeControlSnapshot(id).generation, refreshPiConfiguration: true});
        if (result.contextWindowConfirmationRequired) throw new Error('Pi model settings need a smaller context window; confirm the switch before continuing');
      },
      runtime: {maker: host.maker, isSessionInTurn: host.isSessionInTurn,
        registerPendingCredentialSwitch: selectionHost.registerPendingCredentialSwitchForSession,
        clearPendingCredentialSwitch: selectionHost.clearPendingCredentialSwitchForSession,
        wakeSessionInputQueue: host.wakeSessionInputAfterCredentialSwitch,
        getPendingCredentialSwitch: selectionHost.getPendingCredentialSwitchTarget, logger: host.log},
    }),
  });
  const apply: ApplySessionRuntimeSelection = (id, model, provider, selection, options) => handle(id, model, provider, undefined, selection, options);
  return {handle, apply, setRuntimeAxis, configureModelContext, broadcastSessionRuntimeProjection, persistCredentialRoute: createPendingCredentialSwitchPersistence(pendingHost)};
}
