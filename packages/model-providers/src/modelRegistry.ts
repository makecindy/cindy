import type {
  ModelAgent,
  ModelPriceVariant,
  ModelReferencePrice,
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryRoute,
} from "@cindy/model-access-protocol";

export interface ResolvedModelReferencePrice {
  entry: ModelRegistryEntry;
  route: ModelRegistryRoute;
  price: ModelReferencePrice;
}

export interface ResolveModelReferencePriceOptions {
  agent?: ModelAgent;
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
  if (providerId === "openai" && modelId.startsWith("chatgpt/")) {
    ids.push(modelId.slice("chatgpt/".length));
  }
  return ids;
}

export function findModelRegistryRoute(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  modelId: string,
  agent?: ModelAgent,
): { entry: ModelRegistryEntry; route: ModelRegistryRoute } | undefined {
  if (!registry) return undefined;
  const normalizedProviderId = providerId.trim();
  const normalizedModelId = modelId.trim();
  const candidates = new Set(
    routeModelCandidates(normalizedProviderId, normalizedModelId),
  );
  for (const entry of registry.models) {
    const route = entry.routes.find(
      (candidate) =>
        candidate.providerId === normalizedProviderId &&
        candidates.has(candidate.modelId) &&
        (agent === undefined || candidate.agents.includes(agent)),
    );
    if (route) return { entry, route };
  }
  return undefined;
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
  const matched = findModelRegistryRoute(
    registry,
    providerId,
    modelId,
    options.agent,
  );
  if (!matched?.route.referencePrices) return undefined;
  const day = calendarDate(options.at);
  const inputTokens = options.inputTokens;
  const variant = options.variant ?? "standard";
  const prices = matched.route.referencePrices
    .filter((price) => {
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
  const price = prices[0];
  return price ? { ...matched, price } : undefined;
}
