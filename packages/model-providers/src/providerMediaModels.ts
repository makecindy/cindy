import { providerCatalogId } from "./provider-identity.js";
import type { ModelRegistry } from "./modelAccessBean.js";
import type { ModelMetadata } from "./modelMetadataLayers.js";
import {
  mergeModelMetadata,
  pickModelMetadata,
  registryEntryDefaults,
  resolveModelMetadata,
} from "./modelMetadataLayers.js";
import type { Provider, ProviderMediaModel } from "./types.js";

/** Existing provider lists are projections of V4, not separate model metadata stores. */
export const PROVIDER_MEDIA_FIELDS = [
  "imageModels",
  "videoModels",
  "audioModels",
  "embeddingModels",
] as const;
export type ProviderMediaField = (typeof PROVIDER_MEDIA_FIELDS)[number];

export function providerMediaField(
  mode: string | undefined,
): ProviderMediaField | undefined {
  switch (mode) {
    case "image_generation":
      return "imageModels";
    case "video_generation":
      return "videoModels";
    case "audio_speech":
    case "audio_transcription":
    case "audio_generation":
    case "realtime":
      return "audioModels";
    case "embedding":
      return "embeddingModels";
    default:
      return undefined;
  }
}

/** Registry may declare built-in media routes; account discovery and user providers own membership. */
export function projectProviderMediaModels(
  provider: Provider,
  registry: ModelRegistry | undefined,
  options: {
    addDeclared?: boolean;
    live?: boolean;
    userMetadata?: (modelId: string, model: ProviderMediaModel) => ModelMetadata | undefined;
  } = {},
): Provider {
  if (!registry || registry.schemaVersion < 4) return provider;
  const next = { ...provider };
  const catalogId = providerCatalogId(provider);
  const catalogModelId = (id: string) => catalogId !== provider.id && id.startsWith(`${provider.id}/`)
    ? `${catalogId}/${id.slice(provider.id.length + 1)}` : id;
  const declared = registry.models.flatMap((entry) =>
    entry.routes
      .filter(
        (route) =>
          route.providerId === catalogId && route.agents.length === 0,
      )
      .map((route) => ({
        entry,
        route,
        metadata: mergeModelMetadata(
          registryEntryDefaults(registry, entry, route),
          route.forceOverrides,
        ),
      })),
  );
  const buckets: Partial<Record<ProviderMediaField, ProviderMediaModel[]>> = {};
  for (const field of PROVIDER_MEDIA_FIELDS) {
    const existing = provider[field];
    const models = [...(existing ?? [])];
    if (
      options.addDeclared &&
      provider.source !== "user" &&
      provider.id !== "xd" &&
      existing === undefined
    ) {
      for (const { entry, route, metadata } of declared) {
        if (
          entry.status !== "retired" &&
          providerMediaField(metadata.mode) === field &&
          !models.some((model) => model.id === route.modelId)
        ) {
          models.push({ id: route.modelId, name: metadata.name ?? entry.name });
        }
      }
    }
    if (existing === undefined && models.length === 0) continue;
    buckets[field] ??= [];
    const resolved = models
      .filter(
        (model) =>
          !declared.some(
            ({ entry, route }) =>
              route.modelId === catalogModelId(model.id) && entry.status === "retired",
          ),
      )
      .map((model): ProviderMediaModel => {
        const metadata = resolveModelMetadata(
          registry,
          catalogId,
          catalogModelId(model.id),
          options.live ? pickModelMetadata(model) : model.discoveredMetadata,
          options.userMetadata?.(model.id, model),
        );
        const nativeApi = declared.find(
          ({ route }) => route.modelId === catalogModelId(model.id),
        )?.entry.nativeApi;
        // Preserve the source's real ID, payment state and disable flag.
        return {
          ...model,
          ...metadata,
          ...(nativeApi !== undefined ? { nativeApi } : {}),
          id: model.id,
          name: metadata.name ?? model.name,
        };
      });
    for (const model of resolved) {
      const target = model.mode === undefined ? field : providerMediaField(model.mode);
      if (!target) continue;
      const bucket = (buckets[target] ??= []);
      if (!bucket.some((existing) => existing.id === model.id)) bucket.push(model);
    }
  }
  // Resolve membership first, then defaults: a later source can move into an earlier bucket.
  for (const field of PROVIDER_MEDIA_FIELDS) {
    if (buckets[field] !== undefined) next[field] = buckets[field];
    const defaultsField =
      field === "imageModels"
        ? "imageDefaults"
        : field === "videoModels"
          ? "videoDefaults"
          : field === "embeddingModels"
            ? "embeddingDefaults"
            : undefined;
    if (defaultsField && next[defaultsField]) {
      const ids = new Set((next[field] ?? []).map((model) => model.id));
      const defaults = next[defaultsField]!;
      if (!ids.has(defaults.standard)) delete next[defaultsField];
      else
        next[defaultsField] = {
          standard: defaults.standard,
          ...(defaults.draft && ids.has(defaults.draft)
            ? { draft: defaults.draft }
            : {}),
          ...(defaults.best && ids.has(defaults.best)
            ? { best: defaults.best }
            : {}),
        };
    }
  }
  return next;
}
