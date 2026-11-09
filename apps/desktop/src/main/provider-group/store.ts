/** Platform assembly for the shared service. */
import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
import { createProviderGroupStore } from './storeCore.js';
export type { ProviderGroupBindingCleanup } from './storeCore.js';
export const { readProviderGroup, listProviderGroups, onProviderGroupChanged, writeProviderGroup, listProviderGroupBindingCleanups, completeProviderGroupBindingCleanup, updateProviderGroup, listProviderGroupReshareCleanups, completeProviderGroupReshareCleanup, __testing } = createProviderGroupStore({ withAvailabilityPolicyMutation });
