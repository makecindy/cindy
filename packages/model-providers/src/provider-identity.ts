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

/** Provider identity is separate from the account entry's stable id. */
export function isOpenAiSubscriptionProvider(provider: Pick<Provider, 'id' | 'auth'> | null | undefined): boolean {
  return !!provider && provider.auth?.method === 'oauth'
    && (provider.id === 'openai' || provider.auth.native === 'codex');
}

/** Public catalog identity; never use this key to look up credentials or preferences. */
export function providerCatalogId(provider: Pick<Provider, 'id' | 'auth'>): string {
  return provider.auth.native === 'claude' ? 'anthropic'
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
