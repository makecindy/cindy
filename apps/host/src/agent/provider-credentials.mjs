import { storedCustomProviderId } from '@cindy/model-providers';
import { customProviderSecretStorageKey } from '../../../desktop/src/shared/providerSecrets.ts';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';

/** Runtime-specific credentials never fall back to another provider or the gateway. */
export function createProviderRouteResolver({ catalog, store, ownerId }) {
  const owner = dataOwnerStorageKey(ownerId);
  return async (providerId, agent) => {
    if (!providerId || providerId === 'xd' || providerId === 'cindy') return null;
    const { providers } = await catalog();
    const provider = providers.find(item => item.id === providerId);
    const route = provider?.routing?.[agent];
    if (!route?.upstream) throw new Error('Provider is not configured for this agent');
    const url = new URL(route.upstream);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider endpoint');
    const protocol = route.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
    if ((agent === 'claude-code' && protocol !== 'anthropic-messages') || (agent === 'codex' && protocol !== 'openai-responses')) {
      throw new Error('This provider requires a protocol bridge that Host has not initialized');
    }
    if (provider.auth?.method === 'oauth') throw new Error('This provider requires its OAuth adapter');
    const keyName = customProviderSecretStorageKey(storedCustomProviderId(providerId), agent);
    const apiKey = provider.auth?.method === 'none' ? null : store.read(`owner_${owner}_${keyName}`);
    if (provider.auth?.method !== 'none' && !apiKey) throw new Error('Connect this provider before sending a message');
    return { rawUrl: route.upstream.replace(/\/+$/, ''), anthropicBaseUrl: route.upstream.replace(/\/v1\/?$/, '').replace(/\/+$/, ''), apiKey, protocol };
  };
}
