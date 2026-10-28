/** Public local-client choices. Routing configuration and credentials never cross this projection. */
import { createHash } from 'node:crypto';
import type { AgentKind } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { isModelSelectableForNewRoute } from '@cindy/model-providers';

export interface LocalAgentModel {
  id: string;
  label: string;
  provider: string;
  providerLabel?: string;
  engine: AgentKind;
  model: string;
  efforts: string[];
  defaultEffort?: string;
  images: boolean;
  isDefault: boolean;
}

/** Stable identity includes the source and engine, including same-name custom models. */
export function localAgentModels(
  providers: readonly ProviderView[],
  engines: readonly AgentKind[],
): LocalAgentModel[] {
  const result: LocalAgentModel[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider.connected || provider.suspended || provider.removed) continue;
    for (const engine of provider.agents) {
      if (
        !engines.includes(engine) ||
        !provider.routing[engine] ||
        provider.routing[engine]?.disabled
      )
        continue;
      for (const model of provider.models[engine] ?? []) {
        if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }))
          continue;
        const id = createHash('sha256')
          .update(JSON.stringify([provider.id, engine, model.id]))
          .digest('hex');
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
          id,
          label: `${provider.name} · ${model.name} · ${engine}`,
          provider: provider.id,
          providerLabel: provider.name,
          engine,
          model: model.id,
          efforts: [...model.efforts],
          ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
          images: model.modalities?.input.includes('image') ?? false,
          isDefault: result.length === 0,
        });
      }
    }
  }
  return result;
}
