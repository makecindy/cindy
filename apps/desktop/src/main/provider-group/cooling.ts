/** Cooldowns share the existing store; an error only proves that its task's model is limited. */
import { claudeModelFamily } from '@cindy/maker-shared/subscription-usage';

export const PROVIDER_GROUP_FAILURE_COOLDOWN_MS = 2 * 60_000;
export const PROVIDER_GROUP_COOLING_SCOPE_CAP = 64;
/** Empty scope means account-wide; numeric values are legacy records with unknown scope. */
export type ProviderGroupCooling = number | Record<string, number>;
export type ProviderGroupPersistedCooling = Record<string, Record<string, ProviderGroupCooling>>;

export function coolingScope(model?: string): string {
  if (!model) return '';
  const family = claudeModelFamily(model);
  return family ? `claude:${family}` : `model:${model}`;
}

/** Legacy records may be a model limit mistakenly applied to the whole account. Probe again shortly. */
export function currentCooling(value: ProviderGroupCooling | undefined, now: number): Record<string, number> {
  const scopes = typeof value === 'number'
    ? { '': Math.min(value, now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS) }
    : value ?? {};
  return Object.fromEntries(Object.entries(scopes).filter(([, until]) => until > now));
}
