import { createGuestProviderRouteBinder as createBinder } from '@cindy/remote-agent/host/providerAccess';
import { registerGuestProviderRoute, guestProviderModelAllowed } from '../../maker-host/guest-provider-route-store.js';
export { guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from '@cindy/remote-agent/host/providerAccess';

export function createGuestProviderRouteBinder(deps: Omit<Parameters<typeof createBinder>[0], 'registerRoute' | 'modelAllowed'>) {
  return createBinder({ ...deps, registerRoute: registerGuestProviderRoute, modelAllowed: guestProviderModelAllowed });
}
