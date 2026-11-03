import type { ProviderView } from './registry.js';
import { PROVIDER_MEDIA_FIELDS } from './providerMediaModels.js';

/** Remote Agent selection only. A remote-control view of the computer itself retains its full catalog. */
export function remoteInvocationModels(provider: ProviderView): ProviderView {
  if (provider.remoteModelIds === undefined) return provider;
  const ids = provider.remoteModelIds;
  const allowed = new Set(Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : []);
  const next: ProviderView = { ...provider, models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([agent, models]) => [
    agent, models?.filter((model) => allowed.has(model.id)),
  ])) };
  for (const field of PROVIDER_MEDIA_FIELDS) {
    if (provider[field] !== undefined) next[field] = provider[field].filter((model) => allowed.has(model.id));
  }
  for (const [field, defaultsField] of [
    ['imageModels', 'imageDefaults'], ['videoModels', 'videoDefaults'], ['embeddingModels', 'embeddingDefaults'],
  ] as const) {
    const defaults = provider[defaultsField];
    if (!defaults) continue;
    const ids = new Set(next[field]?.map((model) => model.id));
    if (!ids.has(defaults.standard)) delete next[defaultsField];
    else next[defaultsField] = {
      standard: defaults.standard,
      ...(defaults.draft && ids.has(defaults.draft) ? { draft: defaults.draft } : {}),
      ...(defaults.best && ids.has(defaults.best) ? { best: defaults.best } : {}),
    };
  }
  return next;
}
