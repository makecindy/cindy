/**
 * Host IPC/service wiring for plugin-provided ACP task engines
 * (docs/dev-rules/protocol-compatibility/plugin-harnesses.md).
 *
 * Uses the shared registerPluginEnginesIpc body over Host's Electron-free
 * remote-provider-access, remote-model-access, prefs, and engine-account stores,
 * so Host's local API and Device Link controllers read and manage the exact same
 * owner-scoped plugin engine views as Desktop.
 */
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.js';
import { getPluginHarnessRegistry } from '../../../desktop/src/main/cindy-brain/pluginHarnesses.js';
import { isDeviceLinkInvoke } from '../../../desktop/src/main/device-link/invoke-context.js';
import { createRemoteModelAccessStore } from '../../../desktop/src/main/device-link/remoteModelAccessCore.js';
import type { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import {
  onPluginEnginePrefsChanged,
  readPluginEnginePrefs,
  updatePluginEnginePrefs,
} from '../../../desktop/src/main/maker-host/plugin-engine-prefs-store.js';
import { createPluginEngineRemoteUse } from '../../../desktop/src/main/maker-host/pluginEngineRemoteUseCore.js';
import { createRemoteProviderAccessStore } from '../../../desktop/src/main/maker-host/remoteProviderAccessStoreCore.js';
import { registerPluginEnginesIpc } from '../../../desktop/src/main/maker-ipc/pluginEnginesIpc.js';
import {
  listPluginEngineSeparateProviders,
  onPluginEngineAccountsChanged,
  readPluginEngineTaskUsage,
} from '../../../desktop/src/main/plugin-engine-accounts/runtime.js';
import { PLUGIN_ENGINES_INVOKE, type PluginEngineView } from '../../../desktop/src/shared/pluginEngines.js';
import type { DataOwnerPushStamp } from '../../../desktop/src/shared/dataOwnerPush.js';

export interface HostPluginEnginesDeps {
  availabilityPolicy: Pick<ReturnType<typeof createAvailabilityPolicy>, 'withAvailabilityPolicyMutation'>;
  publish(channel: string, payload: unknown): void;
  isCurrentOwner?(stamp: DataOwnerPushStamp): boolean;
  isDeviceLinkInvoke?(): boolean;
}

export function createHostPluginEngines(deps: HostPluginEnginesDeps) {
  const remoteAccessStore = createRemoteProviderAccessStore({
    withAvailabilityPolicyMutation: (providerId, work) =>
      deps.availabilityPolicy.withAvailabilityPolicyMutation(providerId, work),
  });
  const remoteUse = createPluginEngineRemoteUse({
    isRemoteProviderInvocationAllowed: (providerId) => remoteAccessStore.isRemoteProviderInvocationAllowed(providerId),
    setRemoteProviderInvocationEnabled: (providerId, enabled) => remoteAccessStore.setRemoteProviderInvocationEnabled(providerId, enabled),
  });
  const remoteModelAccess = createRemoteModelAccessStore({
    withMutation: (providerId, work) => deps.availabilityPolicy.withAvailabilityPolicyMutation(providerId, work),
    filePath: () => ownerScopedPath('remote-model-access.json'),
    scopeKey: () => activeOwnerScopeKey(),
  });
  type PluginEnginesIpcHandler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, PluginEnginesIpcHandler>();
  const isCurrentOwner = deps.isCurrentOwner ?? ((stamp: DataOwnerPushStamp) => {
    const current = getActiveDataOwnerPushStamp();
    return !isAppSessionBoundaryPending()
      && stamp.dataOwnerId === current.dataOwnerId
      && stamp.ownerGeneration === current.ownerGeneration;
  });
  const disposeIpc = registerPluginEnginesIpc({
    handle: (channel, listener) => {
      handlers.set(channel, listener as PluginEnginesIpcHandler);
    },
    // Host service routes authenticate the loopback token or Device Link context before calling in.
    assertTrusted: () => {},
    broadcast: (channel, payload) => deps.publish(channel, payload),
    isDeviceLinkInvoke: deps.isDeviceLinkInvoke ?? isDeviceLinkInvoke,
    remoteUse: {
      read: remoteUse.pluginEngineRemoteUse,
      set: remoteUse.setPluginEngineRemoteUse,
      onChange: (listener) => remoteAccessStore.onRemoteProviderAccessChanged(() => listener()),
    },
    settings: {
      read: readPluginEnginePrefs,
      update: updatePluginEnginePrefs,
      onChange: onPluginEnginePrefsChanged,
    },
    readTaskUsage: readPluginEngineTaskUsage,
    accountProviders: {
      list: listPluginEngineSeparateProviders,
      onChange: (listener) => onPluginEngineAccountsChanged((_providerId, change) => { if (!change) listener(); }),
    },
    isCurrentOwner,
  });

  const invoke = (channel: string, args: readonly unknown[] = []): unknown => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Plugin engines handler not registered: ${channel}`);
    return handler({}, ...args);
  };

  return {
    invoke,
    list: () => invoke(PLUGIN_ENGINES_INVOKE.LIST) as PluginEngineView[],
    refresh: (targetGhostId?: unknown) => invoke(PLUGIN_ENGINES_INVOKE.REFRESH, targetGhostId !== undefined ? [targetGhostId] : []),
    usage: (key: unknown, task?: unknown) => invoke(PLUGIN_ENGINES_INVOKE.USAGE, task !== undefined ? [key, task] : [key]),
    setRemoteUse: (input: unknown) => invoke(PLUGIN_ENGINES_INVOKE.SET_REMOTE_USE, [input]),
    setPrefs: (input: unknown) => invoke(PLUGIN_ENGINES_INVOKE.SET_PREFS, [input]),
    remoteUse,
    remoteModelAccess,
    onAccessChanged(listener: () => void): () => void {
      const offAccess = remoteAccessStore.onRemoteProviderAccessChanged(() => listener());
      const offPrefs = onPluginEnginePrefsChanged(listener);
      const offModels = remoteModelAccess.subscribe(listener);
      const offRegistry = getPluginHarnessRegistry().onChange(() => listener());
      return () => {
        offAccess();
        offPrefs();
        offModels();
        offRegistry();
      };
    },
    dispose() {
      disposeIpc();
      handlers.clear();
    },
  };
}
