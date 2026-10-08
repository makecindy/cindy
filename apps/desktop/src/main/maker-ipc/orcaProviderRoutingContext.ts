import type { AgentKind } from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  findModelRegistryRoute,
  isModelSelectableForNewRoute,
  isLocalOnlyProviderForAgent,
  type Catalog,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

import type { ProviderService } from '../maker-host/provider-service.js';
import {
  providerRouteRequiresExplicitSelection,
  type OrcaWorkerProviderRoutingContext,
} from './orcaWorkerCreationService.js';

/** The SSH discovery projection is native OpenAI only and already ordered by remote default. */
export function sshCodexWorkerRoutingContext(views: ProviderView[]): OrcaWorkerProviderRoutingContext {
  const models = views[0]?.models.codex ?? [];
  return {
    remoteCodexModels: models,
    availability: {
      'claude-code': [], pi: [],
      codex: models.length ? [{
        id: 'openai', name: views[0]!.name, models: models.map((model) => model.id),
        fastModels: models.filter((model) => model.supportsFastMode).map((model) => model.id),
        effortMetaByModel: Object.fromEntries(models.map((model) =>
          [model.id, {
            efforts: model.efforts,
            defaultEffort: model.defaultEffort,
            ...(model.effortsUnknown === true ? { effortsUnknown: true } : {}),
          }])),
      }] : [],
    },
    resolveDefaultProviderIdForModel: (agent, model) =>
      agent === 'codex' && models.some((candidate) => candidate.id === model) ? 'openai' : null,
  };
}

/**
 * 运行 Agent 的另一台电脑的目录(那台经设备互联给出的供应商视图)：准入与默认值都以那台为准，
 * 不掺本机目录。默认沿用 lead 的模型与来源(同一种 Agent 且那台仍提供时)，否则取该 Agent 在
 * 那台的第一个可选模型、来源交给那台的默认路由。
 */
export function deviceWorkerRoutingContext(views: ProviderView[], agent: AgentKind): OrcaWorkerProviderRoutingContext {
  const availabilityFor = (kind: AgentKind) =>
    connectedProvidersForAgent(views, kind).map((provider) => {
      const models = routableModels(provider, kind);
      return {
        id: provider.id,
        name: provider.name,
        models: models.map((model) => model.id),
        fastModels: models.filter((model) => model.supportsFastMode).map((model) => model.id),
        effortMetaByModel: Object.fromEntries(
          models.map((model) => [model.id, { efforts: model.efforts, defaultEffort: model.defaultEffort }]),
        ),
      };
    });
  const availability = {
    'claude-code': availabilityFor('claude-code'),
    codex: availabilityFor('codex'),
    pi: availabilityFor('pi'),
  };
  const models = deviceRoutableModels(views, agent);
  return {
    remoteCodexModels: models,
    availability,
    remoteWorkerDefaults: (lead, kind) => {
      const sameAgent = lead.agentKind === kind;
      const leadModelOffered = sameAgent && models.some((model) => model.id === lead.model);
      return {
        model: leadModelOffered ? lead.model : models[0]?.id,
        providerId: leadModelOffered ? lead.providerId : null,
      };
    },
    resolveDefaultProviderIdForModel: (kind, model) => effectiveSourceIdForModel(views, null, model, kind),
  };
}

function routableModels(provider: ProviderView, kind: AgentKind): CatalogModel[] {
  return (provider.models[kind] ?? []).filter((model) =>
    isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
  );
}

/** 那台电脑上某种 Agent 可选的模型(各来源去重，按来源顺序)。 */
function deviceRoutableModels(views: ProviderView[], agent: AgentKind): CatalogModel[] {
  const seen = new Set<string>();
  return connectedProvidersForAgent(views, agent)
    .flatMap((provider) => routableModels(provider, agent))
    .filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

/** list_available_models 用：那台电脑上某种 Agent 的模型、提供它的来源与默认来源。 */
export function deviceAvailableModels(views: ProviderView[], agent: AgentKind): Array<{
  id: string;
  label: string;
  providers: Array<{ id: string; name: string }>;
  defaultProviderId: string | null;
}> {
  const providers = connectedProvidersForAgent(views, agent);
  return deviceRoutableModels(views, agent).map((model) => ({
    id: model.id,
    label: model.name || model.id,
    providers: providers
      .filter((provider) => routableModels(provider, agent).some((entry) => entry.id === model.id))
      .map((provider) => ({ id: provider.id, name: provider.name })),
    defaultProviderId: effectiveSourceIdForModel(views, null, model.id, agent),
  }));
}

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
            {
              efforts: model.efforts,
              defaultEffort: model.defaultEffort,
              // 未声明档位要随快照进入准入,否则自定义来源的占位 [] 会被当成明确无档位(#5535)。
              ...(model.effortsUnknown === true ? { effortsUnknown: true } : {}),
            },
          ]),
        ),
        requiresExplicitRoute: providerRouteRequiresExplicitSelection(
          provider.routing[agent]?.authStrategy,
        ),
        localOnlyForSsh:
          isLocalOnlyProviderForAgent(provider, agent),
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
