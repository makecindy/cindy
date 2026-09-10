import {
  appendModelFieldSources,
  type ModelFieldSources,
  type ModelFieldSource,
} from "./modelFieldSources.js";
import type { ModelPresentation } from "./modelPresentation.js";
import type { CatalogModel } from "./types.js";
import type {
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryRoute,
  ModelEffort,
} from "./modelAccessBean.js";

/** Data only. Membership, credentials, routing and billed prices never inherit. */
export interface ModelMetadata {
  mode?: string;
  modalities?: { input: string[]; output: string[] };
  officialDocs?: string;
  name?: string;
  description?: string;
  group?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort | null;
  supportsFastMode?: boolean;
  supportsImageInput?: boolean;
}
export interface BaseModel {
  presentation?: ModelPresentation;
  id: string;
  aliases: string[];
  defaults: ModelMetadata;
}
export const MODEL_METADATA_FIELDS = [
  "mode",
  "modalities",
  "officialDocs",
  "name",
  "description",
  "group",
  "contextWindow",
  "maxOutputTokens",
  "efforts",
  "defaultEffort",
  "supportsFastMode",
  "supportsImageInput",
] as const;
const efforts = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export function validModelMetadata(value: unknown): value is ModelMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, v]) => {
    if (!(MODEL_METADATA_FIELDS as readonly string[]).includes(key))
      return false;
    if (key === "mode")
      return typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v);
    if (key === "modalities") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const m = v as Record<string, unknown>;
      return (
        Object.keys(m).every((k) => k === "input" || k === "output") &&
        [m.input, m.output].every(
          (list) =>
            Array.isArray(list) &&
            list.length <= 16 &&
            list.every(
              (item) =>
                typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item),
            ) &&
            new Set(list).size === list.length,
        )
      );
    }
    if (key === "officialDocs") {
      if (typeof v !== "string" || v.length > 2048) return false;
      try {
        const url = new URL(v);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }
    if (["name", "description", "group"].includes(key)) {
      const maxLength = key === "name" ? 256 : key === "group" ? 128 : 2000;
      return (
        typeof v === "string" && v.trim().length > 0 && v.length <= maxLength
      );
    }
    if (["contextWindow", "maxOutputTokens"].includes(key))
      return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    if (key === "efforts")
      return (
        Array.isArray(v) &&
        v.every((e) => efforts.has(e)) &&
        new Set(v).size === v.length
      );
    if (key === "defaultEffort") return v === null || efforts.has(v as string);
    return typeof v === "boolean";
  });
}
export function pickModelMetadata(value: object | undefined): ModelMetadata {
  const result: Record<string, unknown> = {};
  for (const key of MODEL_METADATA_FIELDS) {
    const v = (value as Record<string, unknown> | undefined)?.[key];
    if (v !== undefined && validModelMetadata({ [key]: v })) result[key] = v;
  }
  return result as ModelMetadata;
}
/** Undefined inherits; false, null and [] remain explicit values. Arrays replace. */
export function mergeModelMetadata(
  ...layers: (ModelMetadata | undefined)[]
): ModelMetadata {
  return Object.assign({}, ...layers.map(pickModelMetadata));
}
export function findBaseModel(
  registry: ModelRegistry | undefined,
  identity: string,
): BaseModel | undefined {
  const matches =
    registry?.baseModels?.filter(
      (m) => m.id === identity || m.aliases.includes(identity),
    ) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}
export function registryEntryDefaults(
  registry: ModelRegistry,
  entry: ModelRegistryEntry,
  route?: ModelRegistryRoute,
  agent?: string,
  providerDefaults?: ModelMetadata,
): ModelMetadata {
  return mergeModelMetadata(
    entry.modelRef
      ? findBaseModel(registry, entry.modelRef)?.defaults
      : undefined,
    providerDefaults,
    pickModelMetadata(entry),
    route?.defaults,
    agent
      ? pickModelMetadata(
          entry.perAgent?.[agent as keyof NonNullable<typeof entry.perAgent>],
        )
      : undefined,
  );
}
function resolveMetadata(
  registry: ModelRegistry | undefined,
  providerId: string,
  modelId: string,
  live?: ModelMetadata,
  user?: ModelMetadata,
  agent?: string,
  providerDefaults?: ModelMetadata,
  liveSource: ModelFieldSource = "discovery",
  baseModelRef?: string,
): { metadata: ModelMetadata; fieldSources: ModelFieldSources } {
  const ids = [modelId];
  if (providerId === "openai" && modelId.startsWith("chatgpt/"))
    ids.push(modelId.slice(8));
  if (providerId === "xai" && !modelId.startsWith("xai/"))
    ids.push(`xai/${modelId}`);
  if (providerId === "anthropic") ids.push(modelId.replace(/-\d{8}$/, ""));
  for (const id of [...ids]) if (id.endsWith("[1m]")) ids.push(id.slice(0, -4));
  const matched = ids.flatMap(
    (id) =>
      registry?.models.flatMap((entry) =>
        entry.routes
          .filter(
            (route) =>
              route.providerId === providerId &&
              route.modelId === id &&
              (!agent ||
                agent === "pi" ||
                route.agents.includes(agent as never)),
          )
          .map((route) => ({ entry, route })),
      ) ?? [],
  )[0];
  const defaults = baseModelRef
    ? mergeModelMetadata(
        presetBaseMetadata(registry, baseModelRef, agent ?? ""),
        providerDefaults,
        matched?.entry,
        matched?.route.defaults,
        agent
          ? matched?.entry.perAgent?.[
              agent as keyof NonNullable<ModelRegistryEntry["perAgent"]>
            ]
          : undefined,
      )
    : matched && registry
      ? registryEntryDefaults(
          registry,
          matched.entry,
          matched.route,
          agent,
          providerDefaults,
        )
      : mergeModelMetadata(
          findBaseModel(registry, modelId)?.defaults,
          providerDefaults,
        );
  const result = mergeModelMetadata(
    defaults,
    live,
    matched?.route.forceOverrides,
    user,
  );
  let fieldSources: ModelFieldSources = {};
  const add = (
    value: ModelMetadata | undefined,
    source: ModelFieldSource,
    details?: { reason?: string; verifiedAt?: string },
  ) => {
    fieldSources = appendModelFieldSources(
      fieldSources,
      pickModelMetadata(value),
      source,
      details,
    );
  };
  add(
    baseModelRef
      ? presetBaseMetadata(registry, baseModelRef, agent ?? "")
      : findBaseModel(registry, matched?.entry.modelRef ?? modelId)?.defaults,
    "public",
  );
  add(providerDefaults, "provider");
  add(matched?.entry, "access");
  add(matched?.route.defaults, "access");
  add(
    agent
      ? matched?.entry.perAgent?.[
          agent as keyof NonNullable<ModelRegistryEntry["perAgent"]>
        ]
      : undefined,
    "engine",
  );
  add(live, liveSource);
  add(matched?.route.forceOverrides, "verified", {
    reason: matched?.route.overrideReason,
    verifiedAt: matched?.route.overrideVerifiedAt,
  });
  add(user, "user");
  const requestedEffort = result.defaultEffort;
  if (result.efforts?.length === 0) result.defaultEffort = null;
  else if (
    result.defaultEffort != null &&
    result.efforts &&
    !result.efforts.includes(result.defaultEffort)
  ) {
    const order = [...efforts];
    const supported = [...result.efforts].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    result.defaultEffort =
      supported
        .filter(
          (value) =>
            order.indexOf(value) <= order.indexOf(result.defaultEffort!),
        )
        .at(-1) ??
      supported[0] ??
      null;
  }
  if (result.defaultEffort !== requestedEffort)
    add({ defaultEffort: result.defaultEffort }, "constraint");
  return { metadata: result, fieldSources };
}
export function resolveModelMetadata(
  ...args: Parameters<typeof resolveMetadata>
): ModelMetadata {
  return resolveMetadata(...args).metadata;
}
export function resolveModelMetadataWithSources(
  ...args: Parameters<typeof resolveMetadata>
): ModelMetadata & { fieldSources: ModelFieldSources } {
  const result = resolveMetadata(...args);
  return { ...result.metadata, fieldSources: result.fieldSources };
}

/** Legacy consumers receive fully expanded entries without losing saved IDs or routes. */
export function expandedRegistryEntries(
  registry: ModelRegistry,
): ModelRegistryEntry[] {
  if (registry.schemaVersion < 4) return registry.models;
  const usedIds = new Set(registry.models.map((entry) => entry.id));
  return registry.models.flatMap((entry) => {
    const groups = new Map<string, ModelRegistryEntry>();
    for (const route of entry.routes) {
      const metadata = mergeModelMetadata(
        registryEntryDefaults(registry, entry, route),
        route.forceOverrides,
      );
      // Legacy schemas cannot encode a runtime clear against a group default.
      // Move that default to the other runtimes so omission remains an actual clear.
      const runtimeClear =
        metadata.defaultEffort != null &&
        route.agents.some(
          (agent) =>
            mergeModelMetadata(
              registryEntryDefaults(registry, entry, route, agent),
              route.forceOverrides,
            ).defaultEffort === null,
        );
      const overrides = runtimeClear
        ? Object.fromEntries(
            route.agents.map((agent) => [agent, entry.perAgent?.[agent] ?? {}]),
          )
        : entry.perAgent;
      const perAgent = overrides
        ? Object.fromEntries(
            Object.entries(overrides).map(([agent, override]) => {
              const effective = mergeModelMetadata(
                registryEntryDefaults(registry, entry, route, agent),
                route.forceOverrides,
              );
              // Older wire schemas cannot express a null default. Omission preserves their contract.
              const { defaultEffort, ...fields } = effective;
              const { defaultEffort: _oldDefault, ...remainingOverride } =
                override ?? {};
              return [
                agent,
                {
                  ...remainingOverride,
                  ...Object.fromEntries(
                    Object.entries(fields).filter(([key]) =>
                      ["contextWindow", "efforts", "supportsFastMode"].includes(
                        key,
                      ),
                    ),
                  ),
                  ...(defaultEffort != null ? { defaultEffort } : {}),
                },
              ];
            }),
          )
        : undefined;
      const { defaultEffort, supportsImageInput, ...fields } = metadata;
      const expanded = {
        ...entry,
        ...fields,
        perAgent,
        ...(defaultEffort != null ? { defaultEffort } : {}),
      };
      if (defaultEffort === null || runtimeClear) delete expanded.defaultEffort;
      delete expanded.supportsImageInput;
      const key = JSON.stringify(
        { ...expanded, routes: undefined },
        (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
      );
      const previous = groups.get(key);
      if (previous) previous.routes.push(route);
      else groups.set(key, { ...expanded, routes: [route] });
    }
    // Old schemas have entry-level metadata. Split only divergent routes; upstream IDs stay intact.
    return [...groups.values()].map((value, index) => {
      let id = entry.id;
      if (index > 0) {
        let collision = 0;
        do {
          const suffix = `::route-${index + 1}${collision ? `~${collision}` : ""}`;
          id = `${entry.id.slice(0, 256 - suffix.length)}${suffix}`;
          collision += 1;
        } while (usedIds.has(id));
        usedIds.add(id);
      }
      const agents = new Set(value.routes.flatMap((route) => route.agents));
      const perAgent = Object.fromEntries(
        Object.entries(value.perAgent ?? {}).filter(([agent]) =>
          agents.has(agent as never),
        ),
      );
      const next = {
        ...value,
        id,
        ...(value.newSessionDefault
          ? {
              newSessionDefault: value.newSessionDefault.filter((agent) =>
                agents.has(agent),
              ),
            }
          : {}),
      };
      if (Object.keys(perAgent).length) next.perAgent = perAgent;
      else delete next.perAgent;
      if (!next.newSessionDefault?.length) delete next.newSessionDefault;
      return next;
    });
  });
}

export function catalogModelMetadata(
  model: Partial<CatalogModel>,
): ModelMetadata {
  return {
    ...pickModelMetadata(model),
    ...(model.maxOutput !== undefined
      ? { maxOutputTokens: model.maxOutput }
      : {}),
  };
}
export function applyModelMetadata(
  model: CatalogModel,
  metadata: ModelMetadata & { fieldSources?: ModelFieldSources },
): CatalogModel {
  const { maxOutputTokens, fieldSources, ...fields } = metadata;
  const result = {
    ...model,
    ...fields,
    ...(fieldSources
      ? {
          fieldSources: {
            ...model.fieldSources,
            ...Object.fromEntries(
              Object.entries(fieldSources).map(([field, records]) => [
                field,
                records
                  .flatMap((record) =>
                    record.source === "fallback" && model.fieldSources?.[field]
                      ? model.fieldSources[field]
                      : [record],
                  )
                  .filter(
                    (record, index, history) =>
                      history.findLastIndex(
                        (item) => item.source === record.source,
                      ) === index,
                  ),
              ]),
            ),
          },
        }
      : {}),
    ...(metadata.contextWindow !== undefined
      ? { contextWindowVerified: true }
      : {}),
    ...(maxOutputTokens !== undefined ? { maxOutput: maxOutputTokens } : {}),
  };
  if (fieldSources?.name?.at(-1)?.source === "user" && result.presentation) {
    result.presentation = Object.fromEntries(
      Object.entries(result.presentation).map(([locale, copy]) => [
        locale,
        { description: copy.description },
      ]),
    );
  }
  if (
    result.efforts.length === 0 ||
    (result.defaultEffort != null &&
      !result.efforts.includes(result.defaultEffort))
  )
    result.defaultEffort = null;
  return result;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  discoveredMetadata?: ModelMetadata;
}
export function mergeDiscoveredRuntimeModels(
  existing: readonly import("./types.js").ProviderRuntimeModelConfig[],
  discovered: readonly DiscoveredModel[],
  hideNew = false,
) {
  const models = existing.map((model) => ({ ...model }));
  const seen = new Set<string>();
  for (const model of discovered) {
    if (!model.id || !model.name || seen.has(model.id)) continue;
    seen.add(model.id);
    const discoveredMetadata = pickModelMetadata(
      model.discoveredMetadata ?? model,
    );
    const index = models.findIndex((m) => m.id === model.id);
    if (index < 0)
      models.push({
        id: model.id,
        name: model.name,
        discoveredMetadata,
        ...(hideNew ? { defaultEnabled: false } : {}),
      });
    else
      models[index] = {
        ...models[index],
        ...(!models[index].discoveredMetadata ? { nameExplicit: true } : {}),
        discoveredMetadata,
      };
  }
  return models;
}

/** Explicit runtime user fields, shared by initial construction and local public overlays. */
export function runtimeUserModelMetadata(
  m: import("./types.js").ProviderRuntimeModelConfig,
): ModelMetadata {
  return pickModelMetadata({
    ...pickModelMetadata({
      mode: m.mode,
      modalities: m.modalities,
      officialDocs: m.officialDocs,
    }),
    ...(!m.discoveredMetadata || m.nameExplicit ? { name: m.name } : {}),
    ...(m.contextWindow !== undefined
      ? { contextWindow: m.contextWindow }
      : {}),
    ...(m.supportsImageInput !== undefined
      ? { supportsImageInput: m.supportsImageInput }
      : {}),
    ...(m.reasoning !== undefined
      ? { efforts: m.reasoning ? (m.reasoningEfforts ?? []) : [] }
      : {}),
    ...(m.reasoningDefaultEffort !== undefined
      ? { defaultEffort: m.reasoningDefaultEffort }
      : {}),
  });
}

export function presetBaseMetadata(
  registry: ModelRegistry | undefined,
  reference: string | undefined,
  agent: string,
): ModelMetadata | undefined {
  if (!reference) return undefined;
  const value = findBaseModel(registry, reference)?.defaults;
  if (!value || agent !== "pi") return value;
  const {
    efforts: _efforts,
    defaultEffort: _defaultEffort,
    supportsFastMode: _fast,
    ...facts
  } = value;
  return facts;
}
