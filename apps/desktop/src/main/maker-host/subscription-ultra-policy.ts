import {
  nearestSupportedEffort,
  supportsSubscriptionUltraPolicy,
  type Effort,
  type ProviderView,
} from '@cindy/model-providers';
import { getActiveCatalog } from './active-catalog.js';
import { providerUltraPolicy } from './provider-ultra-policy-store.js';

type ModelLike = {
  efforts: string[];
  displayEfforts?: string[];
  defaultEffort: string | null;
};

/** Remove Ultra from the model capability surface when the provider opt-in is off. */
function withoutUltra<T extends ModelLike>(model: T, allowUltra: boolean): T {
  if (
    allowUltra ||
    (!model.efforts.includes('ultra') && !model.displayEfforts?.includes('ultra'))
  ) {
    return model;
  }
  const efforts = model.efforts.filter((effort) => effort !== 'ultra');
  const displayEfforts = model.displayEfforts?.filter((effort) => effort !== 'ultra');
  const defaultEffort =
    model.defaultEffort === 'ultra'
      ? (nearestSupportedEffort('ultra', efforts) as Effort | null)
      : model.defaultEffort;
  return {
    ...model,
    efforts,
    ...(displayEfforts ? { displayEfforts } : {}),
    defaultEffort,
  } as T;
}

export function ultraPolicyEffort(
  allowUltra: boolean,
  effort: string | null | undefined,
  efforts: readonly string[],
): string | null | undefined {
  if (allowUltra || effort !== 'ultra') return effort;
  return nearestSupportedEffort(
    'ultra',
    efforts.filter((candidate) => candidate !== 'ultra'),
  );
}

export function subscriptionUltraAllowed(providerId: string): boolean {
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  if (!supportsSubscriptionUltraPolicy(provider)) return true;
  return providerUltraPolicy.allows(providerId);
}

/**
 * Request-boundary enforcement for saved sessions or remote clients that still carry Ultra.
 * Returns null when no rewrite is needed.
 */
export function applySubscriptionUltraPolicy(
  body: unknown,
  providerId: string | null | undefined,
): unknown | null {
  if (!providerId || subscriptionUltraAllowed(providerId)) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const reasoning = record.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return null;
  if ((reasoning as Record<string, unknown>).effort !== 'ultra') return null;
  const model = typeof record.model === 'string' ? record.model : '';
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  const efforts = provider?.models.codex?.find((entry) => entry.id === model)?.efforts ?? [];
  const nextEffort = ultraPolicyEffort(false, 'ultra', efforts);
  const nextReasoning = { ...(reasoning as Record<string, unknown>) };
  if (nextEffort) nextReasoning.effort = nextEffort;
  else delete nextReasoning.effort;
  return { ...record, reasoning: nextReasoning };
}

/** Effective presentation only: the stored provider definition stays untouched. */
export function projectSubscriptionUltraPolicy(provider: ProviderView): ProviderView {
  if (!supportsSubscriptionUltraPolicy(provider)) return provider;
  const allowUltra = providerUltraPolicy.allows(provider.id);
  return {
    ...provider,
    subscriptionUltraPolicy: { allowUltra },
    models: Object.fromEntries(
      Object.entries(provider.models).map(([agent, models]) => [
        agent,
        models?.map((model) => withoutUltra(model, allowUltra)),
      ]),
    ) as ProviderView['models'],
  };
}
