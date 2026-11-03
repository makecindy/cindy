import { mergeDiscoveredRuntimeModels, isOpenRouterModelsUrl, type DiscoveredModel, type ProviderRuntimeModelConfig } from '@cindy/model-providers';

/** Refresh metadata and append new models; native-engine defaults decide visibility. */
export function appendDiscoveredCustomProviderModels(
  existing: readonly ProviderRuntimeModelConfig[],
  discovered: readonly DiscoveredModel[],
  discoveryUrl?: string,
): { models: ProviderRuntimeModelConfig[]; addedIds: string[] } {
  let prior = existing;
  if (discoveryUrl && isOpenRouterModelsUrl(discoveryUrl)) {
    const actual = new Map(discovered.map(model => [model.id, model]));
    // Repair only discovery-created Anthropic wrappers confirmed by the complete
    // canonical response. Keep manual IDs and never guess another supplier's aliases.
    const canonicalId = (model: ProviderRuntimeModelConfig) => {
      if (actual.has(model.id) || !model.discoveredMetadata || model.nameExplicit || model.route || model.piApi || !model.id.startsWith('anthropic/')) return model.id;
      const candidate = model.id.slice('anthropic/'.length).replace(/\[1m\]$/, '');
      return actual.has(candidate) ? candidate : model.id;
    };
    const normalized = new Map(existing.filter(model => canonicalId(model) === model.id).map(model => [model.id, model]));
    for (const model of existing) {
      const id = canonicalId(model);
      if (id === model.id) continue;
      const canonical = normalized.get(id);
      normalized.set(id, { ...model, ...canonical, id,
        name: canonical?.nameExplicit ? canonical.name : actual.get(id)?.name ?? model.name });
    }
    prior = [...normalized.values()];
  }
  const models = mergeDiscoveredRuntimeModels(prior, discovered);
  const known = new Set(existing.map((model) => model.id));
  return {
    models,
    addedIds: models.filter((model) => !known.has(model.id)).map((model) => model.id),
  };
}
