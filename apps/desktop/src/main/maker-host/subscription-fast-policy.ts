/** Platform assembly for the shared service. */

import { readProviderGroupBinding } from '../provider-group/bindings.desktop.js';
import { readProviderGroup } from '../provider-group/store.js';
import { createSubscriptionFastPolicies } from './subscriptionFastPolicyCore.js';
export const { notifySubscriptionFastPolicyChanged, createSubscriptionFastPolicy, projectSubscriptionFastPolicy } = createSubscriptionFastPolicies({ readProviderGroup, readProviderGroupBinding });
