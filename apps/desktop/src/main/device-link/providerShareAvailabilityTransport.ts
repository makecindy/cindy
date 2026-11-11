import { ProviderShareScopeChangedError } from '@cindy/device-link';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { providerShareOwnerKey } from './providerShareApi.js';

export async function shareAvailabilityRequest<T>(shareId: string, action: string, body: unknown = {}, alternate?: () => Promise<unknown>): Promise<T> {
  const assertCurrent = captureProviderManagementScope();
  const owner = providerShareOwnerKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const verify = () => {
    assertCurrent();
    if (providerShareOwnerKey() !== owner || getClientEndpoint('deviceLinkApiBaseUrl') !== endpoint) throw new ProviderShareScopeChangedError();
  };
  verify();
  const result = await (alternate
    ? alternate()
    : serverApiFetch<unknown>(`/api/device-link/provider-shares/availability/${encodeURIComponent(shareId)}/${action}`, {
      method: 'POST', body, baseUrl: () => { verify(); return endpoint; }, timeoutMs: 15_000,
      allowedRedactedErrorCodes: ['NOT_FOUND'],
      cache: 'no-store', logLabel: '/api/device-link/provider-shares/availability', redactErrorDetails: true,
    })).catch(error => {
      // Late errors must not trigger revocation cleanup in a different account.
      verify();
      throw error;
    });
  verify();
  return result as T;
}

export async function disableShareAvailability(shareId: string): Promise<void> { await shareAvailabilityRequest(shareId, 'disable'); }
