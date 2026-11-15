import type { AgentKind, Provider } from './types.js';

/**
 * Match the native SSH adapters; xAI forwarding remains available. The Claude subscription is
 * local-only for every agent: it only runs through this machine's own Claude Code login.
 */
export function isLocalOnlyProviderForAgent(
  provider: Pick<Provider, 'id' | 'auth' | 'routing'>,
  agent: AgentKind,
): boolean {
  if (agent === 'codex' && provider.routing?.codex?.wireProtocol === 'openai-chat') return true;
  if (provider.auth?.method === 'oauth') {
    const brand = providerCatalogId(provider);
    if (brand === 'openai') return !(agent === 'codex' && provider.id === 'openai');
    if (brand === 'anthropic') return true;
    if (brand === 'xai') return agent !== 'pi';
  }
  return false;
}

type SubscriptionIdentity = Pick<Provider, 'id' | 'auth'> & Pick<Partial<Provider>, 'subscriptionPool'>;

/** Provider identity is separate from the account entry's stable id. */
export function isOpenAiSubscriptionProvider(provider: SubscriptionIdentity | null | undefined): boolean {
  return !!provider && provider.auth?.method === 'oauth'
    && (provider.id === 'openai' || provider.auth.native === 'codex' || provider.subscriptionPool === 'openai');
}

/** A Claude subscription provider: the built-in one or one Cindy created for subscription accounts. */
export function isClaudeSubscriptionProvider(provider: SubscriptionIdentity | null | undefined): boolean {
  return !!provider && provider.auth?.method === 'oauth'
    && (provider.id === 'anthropic' || provider.subscriptionPool === 'anthropic');
}

/** Account policy, never inferred from a display name, endpoint or model family. */
export function supportsSubscriptionFastPolicy(provider: SubscriptionIdentity | null | undefined): boolean {
  return isOpenAiSubscriptionProvider(provider) || isClaudeSubscriptionProvider(provider)
    || (!!provider && provider.auth?.method === 'oauth' && provider.auth.native === 'claude');
}

/** Public catalog identity; never use this key to look up credentials or preferences. */
export function providerCatalogId(provider: SubscriptionIdentity): string {
  return provider.auth.native === 'claude' || provider.subscriptionPool === 'anthropic' ? 'anthropic'
    : provider.auth.native === 'xai' ? 'xai'
    : isOpenAiSubscriptionProvider(provider) ? 'openai' : provider.id;
}

/** Custom-routed providers share Pi/Codex/Claude native routing and credential injection. */
export function isCustomRoutedProvider(provider: Pick<Provider, 'source'> | null | undefined): boolean {
  return provider?.source === 'user' || provider?.source === 'organization';
}

/** Enterprise-owned connection; only local model preferences are editable. */
export function isOrganizationManagedProvider(
  provider: Pick<Provider, 'source'> | null | undefined,
): boolean {
  return provider?.source === 'organization';
}

/**
 * Cindy AI (`xd`) or an enterprise pool connection distributed by Cindy. The server decides
 * which of them carries a model-group Auto and may move it between them; user-added
 * connections never take part.
 */
export function isCindyDistributedProvider(
  provider: Pick<Provider, 'id' | 'source'> | null | undefined,
): boolean {
  return (provider?.source === 'builtin' && provider.id === 'xd') || isOrganizationManagedProvider(provider);
}

/**
 * Cindy Auto, recognized by model id alone: the preset `auto` or a model-group Auto
 * (`auto/<groupId>`). The server routes it upstream and may move it between Cindy sources.
 */
export function isCindyAutoModelId(modelId: string): boolean {
  return modelId === 'auto' || (modelId.startsWith('auto/') && modelId.length > 'auto/'.length);
}
