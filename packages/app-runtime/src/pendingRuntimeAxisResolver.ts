import {effectiveSourceIdForModel,findCatalogModel} from '@cindy/model-providers';
import type {SessionRuntimeAxisPatch,createSessionRuntimeControl} from './sessionRuntimeControl.js';
import type {SessionModelSelectionHost} from './sessionModelSelectionHost.js';
export function createPendingRuntimeAxisResolver(host: Pick<SessionModelSelectionHost, 'getDesktopProviderService' | 'getActiveCatalog' | 'log'> & Pick<ReturnType<typeof createSessionRuntimeControl>, 'getPendingSessionRuntimeMutation' | 'resolveCompatibleSessionRuntimeAxisPatch'>) {
 const {getPendingSessionRuntimeMutation, getDesktopProviderService, getActiveCatalog, resolveCompatibleSessionRuntimeAxisPatch, log} = host;
 return async (
    sessionId: string,
    patch: SessionRuntimeAxisPatch,
  ): Promise<SessionRuntimeAxisPatch> => {
    const pending = getPendingSessionRuntimeMutation(sessionId);
    if (!pending) return patch;
    try {
      const providers = await getDesktopProviderService().listProviders({
        allowSideEffects: false,
        catalog: getActiveCatalog(),
      });
      const pendingProviderId =
        pending.profile.providerId ??
        effectiveSourceIdForModel(
          providers,
          null,
          pending.profile.model,
          pending.profile.agentKind,
        );
      const provider = providers.find((candidate) => candidate.id === pendingProviderId);
      const model = findCatalogModel(provider, pending.profile.model, pending.profile.agentKind, {
        exact: true,
      });
      if (!model) return {};
      return resolveCompatibleSessionRuntimeAxisPatch({
        model,
        profile: pending.profile,
        patch,
      });
    } catch (error) {
      log.debug('pending runtime axis capability lookup failed', {
        sessionId,
        model: pending.profile.model,
        providerId: pending.profile.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  };
}
