import type { AgentKind, CatalogModel } from '@cindy/model-providers';

export interface ShareAvailabilityModel extends Pick<CatalogModel, 'id' | 'name' | 'contextWindow' | 'efforts' | 'defaultEffort'> {
  kind: AgentKind;
  metadata?: Partial<CatalogModel>;
}

// Missing capability declarations are not evidence that another executor's
// capability is supported. Preserve these distinctions, including restrictions.
const EXACT_METADATA = [
  'supportsToolCalls', 'reasoningRequired', 'supportsImageInput', 'supportsFastMode',
  'supportsUltrafastMode', 'thinkingToggle', 'effortsUnknown', 'defaultEnabled', 'status',
] as const;

function metadataValue(model: ShareAvailabilityModel, key: keyof CatalogModel): string | undefined {
  const value = model.metadata?.[key];
  if (key === 'modalities' && model.metadata?.modalities) {
    const { input, output } = model.metadata.modalities;
    return JSON.stringify({ input: [...new Set(input)].sort(), output: [...new Set(output)].sort() });
  }
  return JSON.stringify(value);
}

function isRedundantChatDescription(model: ShareAvailabilityModel, field: keyof CatalogModel): boolean {
  if (field === 'mode') return model.metadata?.mode === 'chat';
  if (field !== 'modalities' || (model.metadata?.mode !== undefined && model.metadata.mode !== 'chat')) return false;
  const images = model.metadata?.supportsImageInput;
  if (images === undefined) return false;
  return metadataValue(model, 'modalities') === JSON.stringify({
    input: images ? ['image', 'text'] : ['text'], output: ['text'],
  });
}

/**
 * The server exposes one description per (kind,id), even across executors.
 * Additive catalog rollouts can add optional descriptions and change a default
 * without changing supported execution. Use an existing, least-annotated
 * description only when every executor agrees with everything it declares.
 * Never invent a capability, intersect effort sets/windows, or remove a route.
 * Genuine conflicts remain unchanged for the server's existing rejection.
 */
export function consistentShareAvailabilityModels<T extends { models: ShareAvailabilityModel[] }>(executors: readonly T[]): T[] {
  const groups = new Map<string, ShareAvailabilityModel[]>();
  const keyOf = (model: ShareAvailabilityModel) => JSON.stringify([model.kind, model.id]);
  for (const executor of executors) for (const model of executor.models) {
    const key = keyOf(model);
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }
  const descriptions = new Map<string, ShareAvailabilityModel>();
  for (const [key, models] of groups) {
    if (models.length < 2) continue;
    const execution = (model: ShareAvailabilityModel) => JSON.stringify([
      model.contextWindow, [...model.efforts].sort(), EXACT_METADATA.map(field => metadataValue(model, field)),
    ]);
    const expected = execution(models[0]);
    if (models.some(model => execution(model) !== expected)) continue;
    const keys = [...new Set(models.flatMap(model => Object.keys(model.metadata ?? {})))] as (keyof CatalogModel)[];
    const common = new Set<keyof CatalogModel>();
    let conflicting = false;
    for (const field of keys) {
      const values = models.map(model => metadataValue(model, field));
      if (new Set(values.filter(value => value !== undefined)).size > 1) { conflicting = true; break; }
      if (values.every(value => value !== undefined)) common.add(field);
      // Only omit redundant chat annotations. A missing mode/modalities value
      // must not erase media capabilities, or silently generalize future fields.
      else if (models.some((model, index) => values[index] !== undefined && !isRedundantChatDescription(model, field))) {
        conflicting = true; break;
      }
    }
    if (conflicting) continue;
    // Choose an actual existing description, not a synthetic mixture. Stable
    // ordering avoids changing the menu default when device iteration changes.
    // Effort sets already match, so one membership check proves support on all.
    const candidates = models.filter(model => Object.keys(model.metadata ?? {}).every(field => common.has(field as keyof CatalogModel))
      && (model.defaultEffort === null || model.efforts.includes(model.defaultEffort)));
    const selected = candidates.reduce<ShareAvailabilityModel | undefined>((best, model) =>
      !best || (model.defaultEffort ?? '') < (best.defaultEffort ?? '') ? model : best, undefined);
    if (selected) descriptions.set(key, selected);
  }
  return executors.map(executor => ({ ...executor, models: executor.models.map(model => {
    const selected = descriptions.get(keyOf(model));
    return selected ? { ...model, defaultEffort: selected.defaultEffort, metadata: selected.metadata } : model;
  }) }));
}
