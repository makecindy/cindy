import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
import { createRemoteProviderAccessStore } from './remoteProviderAccessStoreCore.js';

const desktopStore = createRemoteProviderAccessStore({
  withAvailabilityPolicyMutation: (providerId, work) => withAvailabilityPolicyMutation(providerId, work),
});

export const {
  onRemoteProviderAccessChanged,
  remoteProviderAccessEpoch,
  isRemoteProviderInvocationAllowed,
  setRemoteProviderInvocationEnabled,
  __testing,
} = desktopStore;
