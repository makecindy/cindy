import type { AgentKind, Provider } from './types.js';

/** Match the native SSH adapters; xAI forwarding and native Claude Code remain available. */
export function isLocalOnlyProviderForAgent(
  provider: Pick<Provider, 'id' | 'auth' | 'routing'>,
  agent: AgentKind,
): boolean {
  if (agent === 'codex' && provider.routing?.codex?.wireProtocol === 'openai-chat') return true;
  if (provider.auth?.method === 'oauth') {
    const brand = providerCatalogId(provider);
    if (brand === 'openai') return !(agent === 'codex' && provider.id === 'openai');
    if (brand === 'anthropic') return agent !== 'claude-code';
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
