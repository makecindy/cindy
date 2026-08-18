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
  | "newer"
  | "older"
  | "same"
  | "conflict"
  | "invalid-incoming";

export type ModelRegistrySnapshotDecision =
  | "accept-incoming"
  | "preserve-current"
  | "preserve-current-conflict";

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
  const incomingDigest = modelRegistryCanonicalJson({ ...incoming, updatedAt: canonicalUpdatedAt });
  const currentDigest = modelRegistryCanonicalJson({ ...current, updatedAt: canonicalUpdatedAt });
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
  if (relation === "older" || relation === "invalid-incoming") return "preserve-current";
  return "accept-incoming";
}

export interface ResolvedModelReferencePrice {
  entry: ModelRegistryEntry;
  route: ModelRegistryRoute;
  price: ModelReferencePrice;
}

export interface ResolveModelReferencePriceOptions {
  agent?: ModelAccessV2Agent;
  inputTokens?: number;
  variant?: ModelPriceVariant;
  /** ISO date or Date; defaults to the current day. */
  at?: string | Date;
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
    if (strippedWithoutContextProfile !== stripped) ids.push(strippedWithoutContextProfile);
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
  return matchingModelRegistryRoutes(registry, providerId, modelId, agent)[0];
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
  const day = calendarDate(options.at);
  const inputTokens = options.inputTokens;
  const variant = options.variant ?? "standard";
  for (const matched of matches) {
    const prices = matched.route.referencePrices
      ?.filter((price) => {
        if (price.variant !== variant) return false;
        if (day < price.effectiveFrom) return false;
        if (price.effectiveUntil !== undefined && day >= price.effectiveUntil)
          return false;
        if (inputTokens === undefined) return (price.minInputTokens ?? 0) === 0;
        if (
          price.minInputTokens !== undefined &&
          inputTokens < price.minInputTokens
        )
          return false;
        if (
          price.maxInputTokens !== undefined &&
          inputTokens >= price.maxInputTokens
        )
          return false;
        return true;
      })
      .sort(
        (a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom) ||
          (b.minInputTokens ?? 0) - (a.minInputTokens ?? 0),
      );
    const price = prices?.[0];
    if (price) return { ...matched, price };
  }
  return undefined;
}
