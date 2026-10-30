import type { AgentKind, Provider } from '@cindy/model-providers';

/** Same secure-key / legacy-header alternatives as provider-route. Never exports a credential. */
export function hasCustomProviderCredential(
  provider: Provider,
  readKey: (providerId: string, agent: AgentKind | 'image') => string | null,
): boolean {
  // BYOK image-only providers have no chat agent, but their image credential
  // still determines whether the provider can execute media requests.
  if (provider.source === 'organization' && provider.imageModels?.length) {
    if (readKey(provider.id, 'image')?.trim()) return true;
  }
  return provider.agents.some((agent) => {
    const route = provider.routing[agent];
    if (!route || route.disabled) return false;
    if (route.authStrategy === 'none') return true;
    if (route.authStrategy !== 'api-key-header') return false;
    if (readKey(provider.id, agent)?.trim()) return true;
    return Object.entries(route.headerOverride ?? {}).some(
      ([name, value]) =>
        ['authorization', 'x-api-key'].includes(name.toLowerCase()) && value.trim().length > 0,
    );
  });
}
