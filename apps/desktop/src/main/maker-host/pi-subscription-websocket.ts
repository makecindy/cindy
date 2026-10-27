import { PassThrough } from 'node:stream';
import { standardSpeedRequest } from '@cindy/maker-core';
import { subscriptionRequestAllowsFast } from './subscription-fast-request-policy.js';
import { createWebSocketMessageTransform, type ProxyOptions } from '@cindy/anthropic-compat-proxy';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getChatgptBridgeAuthForDispatch, invalidateChatgptBridgeAuth } from './anthropic-responses-bridge-host.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.js';
import { detectChatgptBridgeAuthInvalidationReason } from './chatgpt-bridge-auth-invalidation.js';
import { buildChatgptBridgeHeaders } from './chatgpt-bridge-headers.js';
import {
  authenticatePiProxySession,
  getPiProxySessionProvider,
  getPiProxySessionSignal,
  isPiProxySubagentRoute,
} from './pi-proxy-session-auth.js';
import { getSessionProvider, hasHostedSessionModelAccess } from './session-provider-store.js';
import { guestProviderRouteForSession } from './guest-provider-route-store.js';

type Context = Parameters<NonNullable<ProxyOptions['resolveWebSocketUpstream']>>[0];

function authenticatedRoute({ url, headers }: Context): { sessionId: string; providerId: string; signal: AbortSignal } | null {
  if (url !== '/codex/responses' || isAppSessionBoundaryPending()) return null;
  const sessionId = headers['x-cindy-pi-session-id'];
  const token = headers['x-cindy-pi-session-token'];
  const providerId = headers['x-cindy-pi-provider-id'];
  if (!sessionId || !token || !isOpenAiSubscriptionProviderId(providerId)
    || !authenticatePiProxySession(sessionId, token)
    || getPiProxySessionProvider(sessionId, token) !== providerId) return null;
  // These routes require a live per-model grant check for every request body.
  // A transparent socket tunnel cannot enforce that contract.
  if (guestProviderRouteForSession(sessionId) || hasHostedSessionModelAccess(sessionId)) return null;
  const selectedProvider = getSessionProvider(sessionId);
  if (!isPiProxySubagentRoute(sessionId, token) && selectedProvider !== null && selectedProvider !== providerId) return null;
  const signal = getPiProxySessionSignal(sessionId, token);
  return signal && !signal.aborted ? { sessionId, providerId, signal } : null;
}

/** Only authenticated ChatGPT subscription requests can reach the fixed upstream. */
export const resolvePiWebSocketUpstream: NonNullable<ProxyOptions['resolveWebSocketUpstream']> = (ctx) =>
  authenticatedRoute(ctx) ? 'https://chatgpt.com/backend-api' : null;

export function createPiWebSocketRequestPreparer(
  readAuth: (providerId: string) => ReturnType<typeof getChatgptBridgeAuthForDispatch>
    = providerId => getChatgptBridgeAuthForDispatch(providerId),
  invalidate: typeof invalidateChatgptBridgeAuth = invalidateChatgptBridgeAuth,
): NonNullable<ProxyOptions['prepareWebSocketRequest']> {
  return async (ctx) => {
    const owner = activeOwnerScopeKey();
    const route = authenticatedRoute(ctx);
    if (!route) throw new Error('PI_WEBSOCKET_ROUTE_UNAVAILABLE');
    const auth = await readAuth(route.providerId);
    const current = authenticatedRoute(ctx);
    if (owner !== activeOwnerScopeKey() || !current || route.signal !== current.signal
      || route.providerId !== current.providerId || !auth.canDispatch()) throw new Error('PI_WEBSOCKET_ROUTE_CHANGED');
    const headers = buildChatgptBridgeHeaders({ ...auth, sessionId: ctx.headers.session_id ?? route.sessionId });
    // Preserve negotiated transport metadata, never child credentials or Cindy-only headers.
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'openai-beta']) {
      if (ctx.headers[name]) headers[name] = ctx.headers[name];
    }
    const authorize = () => {
      const live = authenticatedRoute(ctx);
      return auth.canDispatch() && owner === activeOwnerScopeKey() && live?.signal === route.signal
        && live.providerId === route.providerId;
    };
    const onUpgradeFailure = async (status: number, body: string) => {
      if (!authorize() || !detectChatgptBridgeAuthInvalidationReason(status, body)) return;
      await invalidate({ status, body, failedAccessToken: auth.accessToken }, route.providerId);
    };
    const transforms = () => piWebSocketTransforms(ctx, onUpgradeFailure);
    return { headers, signal: route.signal, authorize, onUpgradeFailure, transforms };
  };
}

/** Enforce live account/task Fast restrictions at each response.create dispatch. */
export function piWebSocketTransforms(
  ctx: Context,
  onAuthFailure?: (status: number, body: string) => Promise<void>,
): ReturnType<NonNullable<ProxyOptions['webSocketTransforms']>> {
  const route = authenticatedRoute(ctx);
  if (!route) throw new Error('PI_WEBSOCKET_ROUTE_UNAVAILABLE');
  return {
    outbound: createWebSocketMessageTransform(true, message => {
      // Check after the complete message arrives, including fragmented requests.
      if (subscriptionRequestAllowsFast(route.sessionId, route.providerId)) return message;
      const restricted = standardSpeedRequest(JSON.parse(message.toString('utf8')));
      return restricted === null ? message : Buffer.from(JSON.stringify(restricted));
    }),
    inbound: onAuthFailure ? createWebSocketMessageTransform(false, async message => {
      // Ordinary content, including text mentioning authentication, cannot revoke
      // credentials. Only bounded explicit provider error events are inspected.
      if (message.length <= 64 * 1024) {
        let event: any;
        try { event = JSON.parse(message.toString('utf8')); } catch { return message; }
        if (event?.type === 'error' || event?.type === 'response.failed') {
          const error = event.error ?? event.response?.error;
          const status = event.status ?? error?.status;
          if (status === undefined || status === 401 || status === 403) {
            // WS errors may omit HTTP status; the existing invalidator still
            // requires an explicit OAuth revocation reason in the error body.
            await onAuthFailure(status ?? 401, JSON.stringify(error ?? event)).catch(() => {});
          }
        }
      }
      return message;
    }) : new PassThrough(),
  };
}
