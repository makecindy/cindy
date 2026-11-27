import { withAvailabilityPolicyMutation } from './providerShareAvailabilityPolicy.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { createRemoteModelAccessStore } from './remoteModelAccessCore.js';

export { createRemoteModelAccessStore };

export const remoteModelAccess = createRemoteModelAccessStore({
  // Same import cycle as the Device Link settings store: forward at call time.
  withMutation: (providerId, work) => withAvailabilityPolicyMutation(providerId, work),
  filePath: () => ownerScopedUserDataPath('remote-model-access.json'),
  scopeKey: () => { captureProviderManagementScope(); return activeOwnerScopeKey(); },
});
