import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { pickConnectedModelForAgent } from '@/lib/draftModelCalibration';
import { isCloudDeviceId } from './cloudDeviceId';

/**
 * The new-task model for a managed cloud instance's draft, chosen from the providers that
 * instance has connected: its flat capabilities list also names subscriptions it has not
 * connected, which a first message cannot use. Uses the same admission and default picker
 * as a local new task, so the model and its source stay paired.
 *
 * Returns undefined when the catalog does not belong to a managed cloud instance or no
 * provider catalog is known (the caller keeps its capabilities-based choice), and null when
 * the connected catalog offers no selectable model.
 */
export function pickCloudDraftModel(input: {
  catalogDeviceId: string | null | undefined;
  providers: readonly ProviderView[] | undefined;
  agentKind: AgentKind | undefined;
  /** The draft's saved source; preferred while it still offers models. */
  providerId: string | null;
  /** An explicit pick, else the draft's saved model. */
  wantedModel: string | undefined;
  /** Whether wantedModel is the user's own choice rather than an automatic seed. */
  explicit: boolean;
}): { model: CatalogModel; providerId: string } | null | undefined {
  const { catalogDeviceId, providers, agentKind, providerId, wantedModel, explicit } = input;
  if (!providers || !agentKind || !isCloudDeviceId(catalogDeviceId)) return undefined;
  const connected = connectedProvidersForAgent([...providers], agentKind)
    .filter((p) => !p.modelDiscoveryFailure)
    .map((p) => ({
      ...p,
      models: {
        ...p.models,
        [agentKind]: (p.models[agentKind] ?? []).filter((m) =>
          isModelSelectableForNewRoute(m, { userProvider: p.source === 'user' }),
        ),
      },
    }));
  const preferred = connected.find(
    (p) => p.id === providerId && (p.models[agentKind]?.length ?? 0) > 0,
  );
  const pool = preferred ? [preferred] : connected;
  const retained = explicit
    ? pool.find((p) => p.models[agentKind]?.some((m) => m.id === wantedModel))
    : undefined;
  const picked =
    retained && wantedModel
      ? { providerId: retained.id, model: wantedModel }
      : pickConnectedModelForAgent(pool, agentKind, explicit ? '' : (wantedModel ?? ''));
  const model = picked
    ? connected
        .find((p) => p.id === picked.providerId)
        ?.models[agentKind]?.find((m) => m.id === picked.model)
    : undefined;
  return picked && model ? { model, providerId: picked.providerId } : null;
}
