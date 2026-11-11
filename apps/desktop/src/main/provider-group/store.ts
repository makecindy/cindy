/** Platform assembly for the shared service. */
import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
import { createProviderGroupStore } from './storeCore.js';
export type { ProviderGroupBindingCleanup } from './storeCore.js';
export const { readProviderGroup, listProviderGroups, onProviderGroupChanged, writeProviderGroup, listProviderGroupBindingCleanups, completeProviderGroupBindingCleanup, updateProviderGroup, listProviderGroupReshareCleanups, completeProviderGroupReshareCleanup, __testing } = createProviderGroupStore({
  // Availability revocation reaches Device Link, whose bootstrap also reads groups.
  // Preserve the live import across that cycle instead of capturing an unset port.
  withAvailabilityPolicyMutation: (providerId, work) => withAvailabilityPolicyMutation(providerId, work),
});
