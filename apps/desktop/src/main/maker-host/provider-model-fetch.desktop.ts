/** Keep Desktop's OAuth token reader and default transport out of the shared fetcher. */
import type { AgentKind, Provider } from '@cindy/model-providers';
import { resolveCopilotAccountUrl } from './copilot-account-url.js';
import { readGenericOAuthAccessToken } from './generic-oauth.desktop.js';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { fetchProviderModels as fetchModels, type ProviderModelsFetchSpec, type ProviderModelsFetchResult } from './provider-model-fetch.js';
export * from './provider-model-fetch.js';

export function fetchProviderModels(spec: ProviderModelsFetchSpec, fetchImpl: typeof fetch = outboundFetch) {
  return fetchModels(spec, fetchImpl);
}

/** Refresh a saved OAuth connection using only Main's route and credential snapshot. */
export async function fetchSavedOAuthProviderModels(
  provider: Provider | undefined,
  agent: AgentKind,
  storageProviderId: string,
  isCurrent: () => boolean,
  fetchImpl: typeof fetch = outboundFetch,
  headers?: Record<string, string>,
): Promise<ProviderModelsFetchResult> {
  const oauth = provider?.auth.oauth;
  const route = provider?.routing[agent];
  if (provider?.source !== 'user' || provider.auth.method !== 'oauth' || !oauth || !route || route.disabled || !isCurrent()) {
    return { ok: false, code: 'AUTH_INVALID' };
  }
  let token: string | null;
  try {
    token = await readGenericOAuthAccessToken(storageProviderId, oauth);
  } catch {
    return { ok: false, code: 'AUTH_INVALID' };
  }
  // A token refresh can outlive logout, account switching, or edits to this connection.
  // Never use the old endpoint snapshot with credentials from the new owner/configuration.
  if (!isCurrent()) return { ok: false, code: 'AUTH_INVALID' };
  if (!token) return { ok: false, code: 'AUTH_INVALID' };
  const modelsUrl = route.modelsUrl ?? oauth.modelsDiscoveryUrl;
  const result = await fetchProviderModels({
    agent,
    baseUrl: resolveCopilotAccountUrl(route.upstream, token),
    modelsUrl: modelsUrl ? resolveCopilotAccountUrl(modelsUrl, token) : modelsUrl,
    wireProtocol: route.wireProtocol,
    authMethod: 'oauth',
    apiKey: token,
    headers,
    redirect: 'error',
  }, async (url, init) => {
    // Pagination and the separate speech catalog may run after the first reply.
    // Revoke the captured credentials before another request if ownership changed.
    if (!isCurrent()) throw new Error('Provider model refresh is no longer current');
    return fetchImpl(url, init);
  });
  return isCurrent() ? result : { ok: false, code: 'AUTH_INVALID' };
}
