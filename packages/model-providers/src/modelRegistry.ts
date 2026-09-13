import {
  registryEntryDefaults,
  findBaseModel,
  referencePricesForRoute,
} from "./modelMetadataLayers.js";
import { modelRegistryCanonicalJson } from "./modelRegistryCanonical.js";
import type {
  ModelAccessV2Agent,
  ModelPriceVariant,
  ModelReferencePrice,
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryRoute,
} from "./modelAccessBean.js";

export type ModelRegistryRevisionRelation =
  "newer" | "older" | "same" | "conflict" | "invalid-incoming";

/** Explicit entries win, then the most specific rule for this exact provider route.
 * Missing data stays unknown; a retired or explicitly unverified entry suppresses family rules.
 */
export function resolveModelNativeApi(
  registry: ModelRegistry | undefined,
  providerId: string,
  modelId: string,
): import("./modelAccessBean.js").ModelNativeApi | null | undefined {
  if (!registry) return undefined;
  const rawId = modelId.replace(/\[1m\]$/, "");
  // Subscription bridges and Pi expose the same route with different wire prefixes.
  // Normalize only these owned identities; never strip arbitrary Gateway namespaces.
  const id =
    providerId === "openai"
      ? rawId.replace(/^chatgpt\//, "")
      : providerId === "xai" && !rawId.startsWith("xai/")
        ? `xai/${rawId}`
        : rawId;
  const entries = registry.models.filter((entry) =>
    entry.routes.some(
      (route) => route.providerId === providerId && route.modelId === id,
    ),
  );
  if (
    entries.some(
      (entry) => entry.status === "retired" || entry.nativeApi === null,
    )
  )
    return null;
  if (registry.schemaVersion < 3) return undefined;
  const explicit = [
    ...new Set(
      entries.flatMap((entry) => (entry.nativeApi ? [entry.nativeApi] : [])),
    ),
  ];
  if (explicit.length) return explicit.length === 1 ? explicit[0] : null;
  return registry.nativeApiRules
    ?.filter(
      (rule) =>
        rule.providerId === providerId &&
        id.startsWith(rule.modelIdPrefix) &&
        !id.slice(rule.modelIdPrefix.length).includes("/"),
    )
    .sort((a, b) => b.modelIdPrefix.length - a.modelIdPrefix.length)[0]
    ?.nativeApi;
}

/** Model identity only, for a model verified in an imported catalog or the Registry.
 * Reuse the declarations already used by Gateway; do not turn an execution API
 * into a manufacturer declaration or copy a Gateway endpoint/capability override.
 * Callers must not pass arbitrary names from a hand-written connection here.
 */
export function resolveCatalogModelNativeApi(
  registry: ModelRegistry | undefined,
  modelId: string,
): import("./modelAccessBean.js").ModelNativeApi | null | undefined {
  if (!registry) return undefined;
  const base = findBaseModel(registry, modelId);
  const entries = registry.models.filter(entry =>
    entry.id === modelId || (base && (entry.id === base.id || entry.modelRef === base.id)),
  );
  if (entries.some(entry => entry.status === 'retired')) return null;
  if (registry.schemaVersion < 3) return undefined;
  const declarations = new Set(entries.flatMap(entry =>
    entry.nativeApi !== undefined ? [entry.nativeApi] : [],
  ));
  if (declarations.size) return declarations.size === 1 ? [...declarations][0] : null;
  const canonicalId = base?.id ?? modelId;
  const declared = resolveModelNativeApi(registry, 'xd', canonicalId);
  if (declared !== undefined) return declared;
  if (canonicalId.includes('/')) return undefined;
  // Direct catalogs may omit the vendor namespace (gemini-*, claude-*, qwen*).
  // Apply only existing declared family prefixes; never strip an unknown input namespace.
  const rules = registry.nativeApiRules?.flatMap(rule => {
    const slash = rule.modelIdPrefix.lastIndexOf('/');
    const prefix = rule.modelIdPrefix.slice(slash + 1);
    return rule.providerId === 'xd' && slash >= 0 && prefix && canonicalId.startsWith(prefix)
      ? [{ prefix, nativeApi: resolveModelNativeApi(registry, 'xd', `${rule.modelIdPrefix.slice(0, slash + 1)}${canonicalId}`) }]
      : [];
  }) ?? [];
  const longest = Math.max(0, ...rules.map(rule => rule.prefix.length));
  const matches = new Set(rules.filter(rule => rule.prefix.length === longest)
    .flatMap(rule => rule.nativeApi !== undefined ? [rule.nativeApi] : []));
  return matches.size > 1 ? null : [...matches][0];
}

export type ModelRegistrySnapshotDecision =
  "accept-incoming" | "preserve-current" | "preserve-current-conflict";

/**
 * Compares immutable Registry revisions by instant, then compares equal-revision content after
 * normalizing equivalent timestamp representations. The protocol parser still requires canonical
 * UTC ISO; this defensive normalization keeps every LKG/refresh guard consistent for typed or
 * previously persisted inputs that can be parsed as the same instant.
 */
export function compareModelRegistryRevisions(
  incoming: ModelRegistry,
  current: ModelRegistry,
): ModelRegistryRevisionRelation {
  const incomingRevision = Date.parse(incoming.updatedAt);
  if (!Number.isFinite(incomingRevision)) return "invalid-incoming";
  const currentRevision = Date.parse(current.updatedAt);
  if (!Number.isFinite(currentRevision)) return "newer";
  if (incomingRevision < currentRevision) return "older";
  if (incomingRevision > currentRevision) return "newer";

  const canonicalUpdatedAt = new Date(incomingRevision).toISOString();
  const incomingDigest = modelRegistryCanonicalJson({
    ...incoming,
    updatedAt: canonicalUpdatedAt,
  });
  const currentDigest = modelRegistryCanonicalJson({
    ...current,
    updatedAt: canonicalUpdatedAt,
  });
  return incomingDigest === currentDigest ? "same" : "conflict";
}

/**
 * Chooses between two complete Catalog snapshots using the Registry as the only monotonic
 * revision. A registry-less incoming snapshot must never erase a current snapshot that already
 * carries Registry state; callers preserve the complete current Catalog rather than mixing layers.
 */
export function decideModelRegistrySnapshot(
  incoming: ModelRegistry | undefined,
  current: ModelRegistry | undefined,
): ModelRegistrySnapshotDecision {
  if (!incoming && current) return "preserve-current";
  if (!incoming || !current) return "accept-incoming";
  const relation = compareModelRegistryRevisions(incoming, current);
  if (relation === "conflict") return "preserve-current-conflict";
  if (relation === "older" || relation === "invalid-incoming")
    return "preserve-current";
  return "accept-incoming";
}

export interface ResolvedModelReferencePrice {
  entry: ModelRegistryEntry;
  route: ModelRegistryRoute;
  price: ModelReferencePrice;
  prices: ModelReferencePrice[];
}

export interface ModelReferencePriceSelection {
  currency?: import("./modelAccessBean.js").ModelCurrency;
  inputTokens?: number;
  variant?: ModelPriceVariant;
  /** ISO date or Date; defaults to the current day. */
  at?: string | Date;
}
export interface ResolveBaseModelReferencePriceOptions extends ModelReferencePriceSelection {
  priceGroup?: string;
}
export interface ResolveModelReferencePriceOptions extends ModelReferencePriceSelection {
  /** Subscription value uses manufacturer tariffs even when a route has its own price. */
  officialOnly?: boolean;
  agent?: ModelAccessV2Agent;
}

function calendarDate(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function routeModelCandidates(providerId: string, modelId: string): string[] {
  const ids = [modelId];
  const withoutContextProfile = modelId.replace(/\[1m\]$/, "");
  if (withoutContextProfile !== modelId) ids.push(withoutContextProfile);
  if (providerId === "openai" && modelId.startsWith("chatgpt/")) {
    const stripped = modelId.slice("chatgpt/".length);
    ids.push(stripped);
    const strippedWithoutContextProfile = stripped.replace(/\[1m\]$/, "");
    if (strippedWithoutContextProfile !== stripped)
      ids.push(strippedWithoutContextProfile);
  }
  if (providerId === "anthropic") {
    const undatedModel = modelId.replace(/-\d{8}$/, "");
    if (undatedModel !== modelId) ids.push(undatedModel);
  }
  return ids;
}

function matchingModelRegistryRoutes(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  modelId: string,
  agent?: ModelAccessV2Agent,
): Array<{ entry: ModelRegistryEntry; route: ModelRegistryRoute }> {
  if (!registry) return [];
  const normalizedProviderId = providerId.trim();
  const normalizedModelId = modelId.trim();
  const candidates = new Set(
    routeModelCandidates(normalizedProviderId, normalizedModelId),
  );
  const anthropicFamily =
    normalizedProviderId === "anthropic" &&
    (normalizedModelId === "opus" ||
      normalizedModelId === "sonnet" ||
      normalizedModelId === "haiku")
      ? `claude-${normalizedModelId}-`
      : null;
  const matches: Array<{
    entry: ModelRegistryEntry;
    route: ModelRegistryRoute;
  }> = [];
  for (const entry of registry.models) {
    for (const route of entry.routes) {
      if (
        route.providerId === normalizedProviderId &&
        (candidates.has(route.modelId) ||
          (anthropicFamily !== null &&
            route.modelId.startsWith(anthropicFamily))) &&
        (agent === undefined || route.agents.includes(agent))
      ) {
        matches.push({ entry, route });
      }
    }
  }
  return matches;
}

export function findModelRegistryRoute(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  modelId: string,
  agent?: ModelAccessV2Agent,
): { entry: ModelRegistryEntry; route: ModelRegistryRoute } | undefined {
  const matched = matchingModelRegistryRoutes(
    registry,
    providerId,
    modelId,
    agent,
  )[0];
  if (!matched || !registry || registry.schemaVersion < 4) return matched;
  return {
    route: matched.route,
    entry: {
      ...matched.entry,
      ...registryEntryDefaults(registry, matched.entry, matched.route),
      ...matched.route.forceOverrides,
    } as ModelRegistryEntry,
  };
}

/**
 * Resolves the currently effective official reference-price band.
 *
 * Availability is intentionally out of scope: callers must still use the active provider
 * catalog / Gateway model list to decide whether the account can actually invoke the model.
 */
export function resolveModelReferencePrice(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  modelId: string,
  options: ResolveModelReferencePriceOptions = {},
): ResolvedModelReferencePrice | undefined {
  const matches = matchingModelRegistryRoutes(
    registry,
    providerId,
    modelId,
    options.agent,
  );
  if (!registry) return undefined;
  for (const matched of matches) {
    const prices = referencePricesForRoute(
      registry,
      matched.entry,
      matched.route,
      options.officialOnly,
    );
    const price = selectReferencePrice(prices, options);
    if (price && prices) return { ...matched, price, prices };
  }
  return undefined;
}

/** Reads a manufacturer's price without requiring any supplier route or account. */
export function resolveBaseModelReferencePrice(
  registry: ModelRegistry | null | undefined,
  modelId: string,
  options: ResolveBaseModelReferencePriceOptions = {},
) {
  const model = findBaseModel(registry ?? undefined, modelId);
  const groups =
    model?.referencePriceGroups?.filter(
      (group) =>
        options.priceGroup === undefined || group.id === options.priceGroup,
    ) ?? [];
  const matches = groups.flatMap((group) => {
    const price = selectReferencePrice(group.prices, options);
    return price ? [{ model: model!, group, price, prices: group.prices }] : [];
  });
  // Market/currency ambiguity is unknown, never array order or a currency conversion.
  return matches.length === 1 ? matches[0] : undefined;
}

function selectReferencePrice(
  prices: ModelReferencePrice[] | undefined,
  options: ModelReferencePriceSelection,
): ModelReferencePrice | undefined {
  const day = calendarDate(options.at);
  const inputTokens = options.inputTokens;
  const variant = options.variant ?? "standard";
  const matches =
    prices?.filter((price) => {
      if (
        price.variant !== variant ||
        (options.currency && price.currency !== options.currency)
      )
        return false;
      if (
        day < price.effectiveFrom ||
        (price.effectiveUntil !== undefined && day >= price.effectiveUntil)
      )
        return false;
      if (inputTokens === undefined) return (price.minInputTokens ?? 0) === 0;
      return (
        inputTokens >= (price.minInputTokens ?? 0) &&
        (price.maxInputTokens === undefined ||
          inputTokens < price.maxInputTokens)
      );
    }) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}
