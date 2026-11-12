import type { LlamaCppCatalogEntry, LlamaCppSnapshot } from './llamaCpp.js';
import {
  recommendForHost,
  resolveCuratedCatalogSpec,
  type LocalModelRecommendInput,
} from './localModelRuntime.js';

/** One shortlist for all runtimes. GGUF candidates inherit identity, never Ollama measurements. */
export function resolveLlamaCppCatalog(remote?: unknown): LlamaCppCatalogEntry[] {
  const spec = resolveCuratedCatalogSpec(remote);
  const ordered = [
    ...spec.featuredIds.map((id) => spec.models.find((model) => model.id === id)!),
    ...spec.models.filter((model) => !spec.featuredIds.includes(model.id)),
  ];
  return ordered.flatMap((model) =>
    model.llamacpp?.length
      ? [
          {
            id: model.id,
            name: model.name,
            aliases: model.aliases,
            descriptions: model.descriptions,
            variants: model.llamacpp,
          },
        ]
      : [],
  );
}

/** Reuse the existing model-level shortlist and hardware gate; keep GGUF execution provisional.
 * Missing packages and explicit withdrawals never promote unrelated candidates.
 */
export function resolveLlamaCppModelLists(
  input: LocalModelRecommendInput,
  remote?: unknown,
): {
  catalog: LlamaCppCatalogEntry[];
  recommendation: NonNullable<LlamaCppSnapshot['recommendation']>;
} {
  const catalog = resolveLlamaCppCatalog(remote);
  const host = recommendForHost(input, remote);
  const featuredIds = [host.primary, host.secondary].flatMap((model) => {
    if (!model) return [];
    const entry = catalog.find((entry) => entry.id === model.id);
    // Weight size is only an exclusion, never a claim about runtime memory.
    return entry?.variants.some((variant) => variant.sizeBytes < input.totalmemBytes)
      ? [entry.id]
      : [];
  });
  return {
    catalog,
    recommendation: { featuredIds, memoryGb: host.memoryGb, appleSilicon: host.appleSilicon },
  };
}
