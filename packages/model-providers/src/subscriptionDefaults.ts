import type { AgentKind, Provider } from './types.js';
import { providerCatalogId } from './provider-identity.js';

/** Only the existing subscription namespaces are aliases; paid/context variants stay distinct. */
export function subscriptionModelKey(providerId: string, modelId: string): string {
  const prefix = providerId === 'openai' ? 'chatgpt/' : providerId === 'anthropic' ? 'anthropic/' : providerId === 'xai' ? 'xai/' : undefined;
  return prefix && modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

export function validateSubscriptionDefaults(provider: Provider): void {
  const defaults = provider.newSessionDefaults;
  if (defaults === undefined) return;
  const path = `provider '${provider.id}' newSessionDefaults`;
  if (provider.access?.kind !== 'subscription' || !defaults || typeof defaults !== 'object' || Array.isArray(defaults))
    throw new Error(`${path} requires a subscription and a Harness-to-model object`);
  for (const [agent, id] of Object.entries(defaults)) {
    if (!['claude-code', 'codex', 'pi'].includes(agent) || !provider.agents.includes(agent as AgentKind)
      || !provider.routing[agent as AgentKind] || typeof id !== 'string' || !id.trim() || id !== id.trim())
      throw new Error(`${path}.${agent} must name a model for a supported Harness`);
  }
}

/** Project defaults only onto assembled members. Configuration never grants model access. */
export function applySubscriptionDefaults(provider: Provider): Provider {
  if (provider.access?.kind !== 'subscription' || provider.newSessionDefaults === undefined) return provider;
  return { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) => {
    const selected = provider.newSessionDefaults?.[agent as AgentKind];
    return [agent, models?.map(model => {
      const { newSessionDefault: _previous, ...rest } = model;
      return selected && subscriptionModelKey(providerCatalogId(provider), selected) === subscriptionModelKey(providerCatalogId(provider), model.id)
        ? { ...rest, newSessionDefault: [agent as AgentKind] } : rest;
    })];
  })) };
}
