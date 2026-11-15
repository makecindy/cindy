import type { ProviderOAuthTokenReadOptions } from './provider-route.js';

export function createXaiProviderTokenReader(ports: Pick<typeof import('./grok-oauth-login.desktop.js'), 'getGrokAccessToken' | 'recoverGrokAuthAfterRejection'>) {
const { getGrokAccessToken, recoverGrokAuthAfterRejection } = ports;
return async function readXaiProviderOAuthToken(
  options?: ProviderOAuthTokenReadOptions,
  providerId = 'xai',
): Promise<string | null> {
  if (!options?.forceRefresh) return getGrokAccessToken(providerId);

  // A forced retry must stay bound to the exact bearer rejected upstream. Without that
  // baseline we cannot safely decide which account generation to refresh.
  const staleToken = options.staleToken;
  if (!staleToken) return null;

  const outcome = await recoverGrokAuthAfterRejection(staleToken, providerId);
  if (outcome !== 'refreshed' && outcome !== 'superseded') return null;

  // `superseded` means another request/login already replaced the rejected credential.
  // Return that newer token, but never replay the bearer which caused the 401/403.
  const token = await getGrokAccessToken(providerId);
  return token !== staleToken ? token : null;
};
}
