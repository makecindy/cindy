import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import { deriveAvailableModels } from '../maker-host/catalog-to-descriptors.js';

/** Only model discovery can be answered by the published directory, never runtime status. */
export function isShareAvailabilityRead(channel: string, args: unknown[]): boolean {
  return channel === 'maker:provider:list' || channel === 'maker:list-available-agents'
    || (channel === 'maker:get-capabilities' && args.length === 1 && typeof args[0] === 'string'
      && ['claude-code', 'codex', 'pi'].includes(args[0]));
}

export function projectShareAvailabilityRead(catalog: { providers: ProviderView[] }, channel: string, args: unknown[]): unknown {
  if (channel === 'maker:provider:list') return catalog;
  const agents = [...new Set(catalog.providers.flatMap(provider => provider.agents))];
  if (channel === 'maker:list-available-agents') return agents;
  const availableModels = deriveAvailableModels({ version: 'share-availability', providers: catalog.providers }, args[0] as AgentKind);
  // The directory proves model capabilities, not an executor's optional runtime
  // features or permission modes. Fast also requires a live policy declaration.
  return {
    availableModels: availableModels.map(model => ({ ...model, supportsFastMode: false, supportsUltrafastMode: false })),
    effortLevels: [...new Set(availableModels.flatMap(model => model.efforts))].map(id => ({ id, displayName: id })),
    permissionModes: [],
    hasFastMode: false,
  };
}

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
