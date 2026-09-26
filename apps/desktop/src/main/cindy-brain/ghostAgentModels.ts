import {
  connectedProvidersForAgent,
  isModelVisible,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import type { GhostAgentModelsResult } from '../../shared/ghost.js';

/** Project each provider separately: the same model can support different efforts per route. */
export function projectGhostAgentModels(views: ProviderView[], visibilityOverride: (agent: 'codex' | 'claude-code' | 'pi', providerId: string, modelId: string) => boolean | undefined = () => undefined): GhostAgentModelsResult {
  const models: Extract<GhostAgentModelsResult, { ok: true }>['models'] = [];
  for (const agent of ['codex', 'claude-code', 'pi'] as const) {
    for (const provider of connectedProvidersForAgent(views, agent)) {
      for (const model of provider.models[agent] ?? []) {
        if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }))
          continue;
        models.push({
          visible: isModelVisible(visibilityOverride(agent, provider.id, model.id), model.defaultEnabled),
          id: model.id,
          name: model.name,
          agent,
          providerId: provider.id,
          providerName: provider.name,
          efforts: [...model.efforts],
          defaultEffort: model.defaultEffort,
        });
      }
    }
  }
  return { ok: true, models };
}
