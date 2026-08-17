import type { AgentKind } from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  findModelRegistryRoute,
  isModelSelectableForNewRoute,
  type Catalog,
  type ProviderView,
} from '@cindy/model-providers';

import type { ProviderService } from '../maker-host/provider-service.js';
import {
  providerRouteRequiresExplicitSelection,
  type OrcaWorkerProviderRoutingContext,
} from './orcaWorkerCreationService.js';

/**
 * Build the Orca worker route snapshot from one post-claim full catalog.
 *
 * `listProviders` invokes `getCatalog` after all connection readers settle. Keeping the exact
 * object returned by that callback lets the registry identity lookup use the same catalog as the
 * provider views, instead of mixing a pre-claim selectable projection with post-claim views.
 */
export async function readOrcaWorkerProviderRoutingContext(deps: {
  providerService: ProviderService;
  getCatalog: () => Catalog;
}): Promise<OrcaWorkerProviderRoutingContext> {
  let postClaimCatalog: Catalog | undefined;
  const views = await deps.providerService.listProviders({
    allowSideEffects: true,
    waitForDiscovery: true,
    getCatalog: () => {
      postClaimCatalog = deps.getCatalog();
      return postClaimCatalog;
    },
  });
  const catalog = postClaimCatalog ?? deps.getCatalog();
  const modelRegistry = catalog.modelRegistry;

  // Keep the route policy aligned with modelList.ts: disabled/non-chat capability entries do not
  // enter a new worker route, while the model registry identity remains provider-specific.
  const routableModels = (provider: ProviderView, agent: AgentKind) =>
    (provider.models[agent] ?? []).filter((model) =>
      isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
    );
  const availabilityFor = (agent: AgentKind) =>
    connectedProvidersForAgent(views, agent).map((provider) => {
      const models = routableModels(provider, agent);
      const registryIdentityByModel = Object.fromEntries(
        models.flatMap((model) => {
          const matched = findModelRegistryRoute(
            modelRegistry,
            provider.id,
            model.id,
            agent === 'pi' ? undefined : agent,
          );
          return matched ? [[model.id, matched.entry.id]] : [];
        }),
      );
      return {
        id: provider.id,
        name: provider.name,
        models: models.map((model) => model.id),
        registryIdentityByModel,
        fastModels: models.filter((model) => model.supportsFastMode).map((model) => model.id),
        effortMetaByModel: Object.fromEntries(
          models.map((model) => [
            model.id,
            { efforts: model.efforts, defaultEffort: model.defaultEffort },
          ]),
        ),
        requiresExplicitRoute: providerRouteRequiresExplicitSelection(
          provider.routing[agent]?.authStrategy,
        ),
        chatBridgedCodex:
          agent === 'codex' && provider.routing[agent]?.wireProtocol === 'openai-chat',
      };
    });

  return {
    availability: {
      'claude-code': availabilityFor('claude-code'),
      codex: availabilityFor('codex'),
      pi: availabilityFor('pi'),
    },
    resolveDefaultProviderIdForModel: (agent, model) =>
      effectiveSourceIdForModel(views, null, model, agent),
  };
}
