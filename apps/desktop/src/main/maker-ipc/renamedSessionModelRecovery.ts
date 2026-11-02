import {
  uniqueRenamedSessionModelId,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

type SavedRoute = {
  model: string;
  providerId: string | null;
  agentKind: AgentKind;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
  status: string;
  remoteHostId: string | null;
  agentDeviceId: string | null;
};

/** Run under the send lock, including sends with no pending model selection. */
export async function recoverRenamedSessionModelBeforeSend(input: {
  route: SavedRoute | null;
  effectiveRoute: Pick<SavedRoute, 'model' | 'providerId' | 'agentKind' | 'effort' | 'fastMode'> | null;
  hasPendingSelection: boolean;
  providers: readonly ProviderView[];
  apply: (model: string, providerId: string) => Promise<{
    deferred: boolean;
    superseded: boolean;
    contextWindowConfirmationRequired?: number;
  }>;
}): Promise<boolean> {
  const { route } = input;
  if (!route || route.status !== 'active' || !route.providerId ||
      route.remoteHostId || route.agentDeviceId || input.hasPendingSelection) return false;
  // A temporary or fallback route owns the next send. Rewriting the saved
  // baseline through SET_MODEL would replace that accepted route and its axes.
  const effective = input.effectiveRoute;
  if (!effective || effective.model !== route.model ||
      effective.providerId !== route.providerId || effective.agentKind !== route.agentKind ||
      effective.effort !== route.effort || effective.fastMode !== route.fastMode) return false;
  const provider = input.providers.find(candidate => candidate.id === route.providerId);
  // A suspended provider's existing route may continue without new-route admission.
  if (provider?.suspended === true) return false;
  const replacement = uniqueRenamedSessionModelId(provider, route.model, route.agentKind);
  if (!replacement) return false;
  const result = await input.apply(replacement, route.providerId);
  if (result.deferred || result.superseded || result.contextWindowConfirmationRequired) {
    throw new Error('Renamed session model could not be applied before send');
  }
  return true;
}
