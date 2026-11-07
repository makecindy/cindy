import { restrictSubscriptionRequest } from './subscription-fast-request-policy.js';
import { applySubscriptionUltraPolicy } from './subscription-ultra-policy.js';

/**
 * WebSocket frames bypass the routing-level Fast policy, so both subscription
 * policies run on the frame itself. Keep the Ultra rewrite when Fast has
 * nothing to change; otherwise the frame could still carry Ultra while the
 * provider opt-in is off.
 */
export function applyCodexWebSocketSubscriptionPolicies(
  body: unknown,
  providerId: string | null | undefined,
  sessionId: string | null | undefined,
): unknown | null {
  const ultraBody = applySubscriptionUltraPolicy(body, providerId);
  const fastBody = restrictSubscriptionRequest(ultraBody ?? body, sessionId, providerId);
  return fastBody ?? ultraBody;
}
