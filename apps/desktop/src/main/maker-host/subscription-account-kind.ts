import { getActiveCatalog } from './active-catalog.js';


export function subscriptionAccountKind(providerId?: string | null): 'claude' | 'xai' | null {
  const native = getActiveCatalog().providers.find((p) => p.id === providerId)?.auth.native;
  return native === 'claude' || native === 'xai' ? native : null;
}

export function isClaudeSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'anthropic' || subscriptionAccountKind(providerId) === 'claude';
}

export function isXaiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'xai' || subscriptionAccountKind(providerId) === 'xai';
}
