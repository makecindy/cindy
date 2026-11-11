/** Platform assembly for the shared service. */

import { createSubscriptionFastPolicy } from './subscription-fast-policy.js';
import { createSubscriptionFastRequestPolicy } from './subscriptionFastRequestCore.js';
export const { subscriptionRequestAllowsFast, restrictSubscriptionRequest, withSubscriptionFastRequestPolicy } = createSubscriptionFastRequestPolicy({ createSubscriptionFastPolicy });
