import {
  readCustomProviderHeadersForMutation,
  removeCustomProviderHeaders,
  storeCustomProviderHeaders,
  UNRECOVERABLE_PROVIDER_CREDENTIAL,
} from '../secrets/providerSecretStore.js';
import {
  listCustomProviders,
  updateCustomProvider,
} from './custom-provider-store.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { createCustomProviderHeaderService } from './customProviderHeaderService.js';
export type { CustomProviderHeaderSecrets } from './customProviderHeaderService.js';
export const { CUSTOM_PROVIDER_RUNTIME_AGENTS, splitCustomProviderHeaders, hydrateCustomProviderHeaders, listCustomProvidersWithSecureHeaders } = createCustomProviderHeaderService({
  readCustomProviderHeadersForMutation: (...args) => readCustomProviderHeadersForMutation(...args),
  removeCustomProviderHeaders: (...args) => removeCustomProviderHeaders(...args),
  storeCustomProviderHeaders: (...args) => storeCustomProviderHeaders(...args),
  listCustomProviders: (...args) => listCustomProviders(...args),
  updateCustomProvider: (...args) => updateCustomProvider(...args),
  getCurrentDbClientUserId: () => getCurrentDbClientUserId(),
});
