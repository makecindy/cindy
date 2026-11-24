/**
 * The effort and fast-mode patch a task can still take while a runtime change is pending: checked
 * against the pending model's capabilities, not the running one's. Moved verbatim out of
 * register.ts so the Node Host runs the same check; register.ts binds the ports.
 *
 * The provider service (createDesktopProviderService.ts loads Electron) and the logger come in as
 * ports. A lookup that fails, or a pending model the catalog no longer has, drops the patch.
 */
import { effectiveSourceIdForModel, findCatalogModel } from '@cindy/model-providers';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import type { Logger } from '../logger.js';
import {
  getPendingSessionRuntimeMutation,
  resolveCompatibleSessionRuntimeAxisPatch,
  type SessionRuntimeAxisPatch,
} from './sessionRuntimeControl.js';

export interface PendingRuntimeAxisPatchPorts {
  getDesktopProviderService: () => Pick<ReturnType<typeof import('../maker-host/createDesktopProviderService.js').getDesktopProviderService>, 'listProviders'>;
  log: Logger;
}

/** resolvePendingRuntimeAxisPatch, as register.ts declared it. */
export function createResolvePendingRuntimeAxisPatch(ports: PendingRuntimeAxisPatchPorts) {
  const { getDesktopProviderService, log } = ports;

  const resolvePendingRuntimeAxisPatch = async (
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
  return resolvePendingRuntimeAxisPatch;
}
