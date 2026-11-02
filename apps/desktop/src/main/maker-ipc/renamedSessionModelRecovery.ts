import {
  uniqueRenamedSessionModelId,
  type AgentKind,
  type Provider,
  type ProviderView,
} from '@cindy/model-providers';

type SavedRoute = {
  model: string;
  providerId: string | null;
  agentKind: AgentKind;
  status: string;
  remoteHostId: string | null;
  agentDeviceId: string | null;
};

/** Run under the send lock, including sends with no pending model selection. */
export async function recoverRenamedSessionModelBeforeSend(input: {
  route: SavedRoute | null;
  hasPendingSelection: boolean;
  providers: readonly (Provider | ProviderView)[];
  apply: (model: string, providerId: string) => Promise<{
    deferred: boolean;
    superseded: boolean;
    contextWindowConfirmationRequired?: number;
  }>;
}): Promise<boolean> {
  const { route } = input;
  if (!route || route.status !== 'active' || !route.providerId ||
      route.remoteHostId || route.agentDeviceId || input.hasPendingSelection) return false;
  const provider = input.providers.find(candidate => candidate.id === route.providerId);
  const replacement = uniqueRenamedSessionModelId(provider, route.model, route.agentKind);
  if (!replacement) return false;
  const result = await input.apply(replacement, route.providerId);
  if (result.deferred || result.superseded || result.contextWindowConfirmationRequired) {
    throw new Error('Renamed session model could not be applied before send');
  }
  return true;
}
