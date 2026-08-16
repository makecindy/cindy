import type { ProviderRuntimeModelConfig, ProviderWireProtocol } from './types.js';

/** Pi treats an omitted wire protocol as its effective OpenAI Chat default. */
export function effectivePiWireProtocol(
  value: ProviderWireProtocol | undefined,
): ProviderWireProtocol {
  return value ?? 'openai-chat';
}

function projectedPiCatalogFields(model: ProviderRuntimeModelConfig): object {
  return {
    name: model.name,
    contextWindow: model.contextWindow,
    supportsImageInput: model.supportsImageInput,
    reasoning: model.reasoning,
    reasoningEfforts: model.reasoningEfforts,
    reasoningDefaultEffort: model.reasoningDefaultEffort,
  };
}

/**
 * Whether an edited model list still represents the same catalog-backed models.
 *
 * New models and presentation-only edits may coexist with the catalog snapshot, but every
 * previously saved model must still exist with the same catalog-projected fields. First-wins
 * duplicate handling mirrors custom-provider persistence normalization, so a duplicate row cannot
 * hide a replacement or metadata override from the main-process check.
 */
export function preservesPiCatalogModels(
  previous: readonly ProviderRuntimeModelConfig[] | undefined,
  next: readonly ProviderRuntimeModelConfig[] | undefined,
): boolean {
  const nextById = new Map<string, ProviderRuntimeModelConfig>();
  for (const model of next ?? []) {
    if (!nextById.has(model.id)) nextById.set(model.id, model);
  }
  return (previous ?? []).every((model) => {
    const candidate = nextById.get(model.id);
    return candidate !== undefined
      && JSON.stringify(projectedPiCatalogFields(model))
        === JSON.stringify(projectedPiCatalogFields(candidate));
  });
}
