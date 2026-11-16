import { randomUUID } from 'node:crypto';
import { isProviderSharePeer, isSharedTaskPeer } from '@cindy/device-link';
import { isModelSelectableForNewRoute } from '@cindy/model-providers';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { readDeviceLinkSettings } from '../../device-link/settings-store.desktop.js';
import {
  deviceAccessGeneration, isControllerAccessAllowed, onRemoteControlAccessChanged, remoteControlAccessGeneration,
} from '../../device-link/remoteControlAccess.js';
import { setRemoteUtilityTextHandler } from '../../device-link/dispatch.desktop.js';
import { getActiveCatalog, isXdGatewayPaymentRequiredRoute } from '../../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../../maker-host/model-disable-store.js';
import { isProviderModelRouteDisabled } from '../../maker-host/model-route-availability.js';
import { getProviderRouteCredentialRevision, isProviderRouteMutationInProgress } from '../../maker-host/provider-route.js';
import {
  isRemoteProviderOpenToOwnComputers, onRemoteProviderAccessChanged, remoteProviderAccessEpoch,
} from '../../maker-host/remote-provider-access-store.js';
import { readProviderGroup } from '../../provider-group/store.js';
import { hasOneshotProviderCredential } from '../oneshotProviderUsability.js';
import { buildTextOneshotPinOptions } from '../textOneshotPinOptions.js';
import { createRemoteUtilityHost, type RemoteUtilityHostDeps } from './host.js';

let dispose: (() => void) | undefined;

/**
 * Desktop assembly for the same-account short-text RPC. It reuses the provider
 * catalog, remote-use grants, disable axis and the local explicit-route executor;
 * it adds no session, tool, memory or provider directory of its own.
 */
export function installRemoteUtilityTextHost(execute: RemoteUtilityHostDeps['execute']): void {
  disposeRemoteUtilityTextHost();
  const owner = activeOwnerScopeKey();
  const hostEpoch = randomUUID();

  /** The live authorization identity of one caller, optionally for one exact route. */
  const current: RemoteUtilityHostDeps['current'] = (caller, route) => {
    const settings = readDeviceLinkSettings();
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner
      || isProviderSharePeer(caller) || isSharedTaskPeer(caller)
      || !settings.remoteControlEnabled || !isControllerAccessAllowed(caller)
      || settings.modelUseRevokedControllers?.includes(caller)) return null;
    // A route is valid only while it is still offered everywhere it was offered before.
    let routeState: unknown = null;
    if (route) {
      const provider = getActiveCatalog().providers.find((item) => item.id === route.providerId);
      const model = provider?.models[route.agentKind]?.find((item) => item.id === route.model);
      if (!provider || !model || !provider.agents.includes(route.agentKind)
        || !isRemoteProviderOpenToOwnComputers(provider.id) || readProviderGroup(provider.id)
        || isProviderRouteMutationInProgress(provider.id)
        || isProviderModelRouteDisabled(provider.id, route.model)
        || !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })
        || (provider.id === 'xd' && isXdGatewayPaymentRequiredRoute(route.model, route.agentKind))) return null;
      routeState = [
        remoteProviderAccessEpoch(provider.id), getProviderRouteCredentialRevision(provider.id),
        provider.routing[route.agentKind], provider.auth, model.route, model.api, model.piApi,
      ];
    }
    return {
      owner, hostEpoch,
      authorizationEpoch: JSON.stringify([remoteControlAccessGeneration(), deviceAccessGeneration(caller), routeState]),
    };
  };

  const host = createRemoteUtilityHost({
    current,
    allowedRoutes: async (caller) => {
      if (!current(caller)) return [];
      // The executor's own admission decides which catalog routes can really run;
      // remote-use grants and provider groups are applied before that check.
      const catalog = getActiveCatalog();
      return buildTextOneshotPinOptions({
        version: catalog.version,
        providers: catalog.providers.filter((provider) =>
          isRemoteProviderOpenToOwnComputers(provider.id) && !readProviderGroup(provider.id)),
      }, readModelDisableOverrides(), undefined, hasOneshotProviderCredential, 'auxiliary')
        .map(({ providerId, agentKind, modelId }) => ({ providerId, agentKind, model: modelId }));
    },
    execute,
  });
  setRemoteUtilityTextHandler(host);

  // Reuse the existing permission generations and change notifications instead of polling.
  const stopAccess = onRemoteControlAccessChanged((scope) => {
    if (activeOwnerScopeKey() !== owner) return;
    if (scope === 'all') host.abortAll({ owner, hostEpoch });
    else host.abortController(scope.deviceId, { owner, hostEpoch });
  });
  const stopProvider = onRemoteProviderAccessChanged(() => { void host.revalidateModelAccess(); });
  dispose = () => {
    stopAccess();
    stopProvider();
    host.abortAll();
    setRemoteUtilityTextHandler(null);
  };
}

export function disposeRemoteUtilityTextHost(): void {
  dispose?.();
  dispose = undefined;
}
