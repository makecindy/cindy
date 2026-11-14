
// The transport lives in piSubscriptionWebSocketCore.ts (shared with the Node Host).
// This module builds the single Desktop instance with call-time ports.
import { createPiSubscriptionWebSocket } from './piSubscriptionWebSocketCore.js';
import { subscriptionRequestAllowsFast } from './subscription-fast-request-policy.js';
import { getChatgptBridgeAuthForDispatch, invalidateChatgptBridgeAuth } from './anthropic-responses-bridge-host.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.desktop.js';

const desktopPiWebSocket = createPiSubscriptionWebSocket({
  subscriptionRequestAllowsFast: (...args) => subscriptionRequestAllowsFast(...args),
  getChatgptBridgeAuthForDispatch: (...args) => getChatgptBridgeAuthForDispatch(...args),
  invalidateChatgptBridgeAuth: (...args) => invalidateChatgptBridgeAuth(...args),
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
});
type Instance = typeof desktopPiWebSocket;

export function resolvePiWebSocketUpstream(...args: Parameters<Instance['resolvePiWebSocketUpstream']>): ReturnType<Instance['resolvePiWebSocketUpstream']> {
  return desktopPiWebSocket.resolvePiWebSocketUpstream(...args);
}

export function createPiWebSocketRequestPreparer(...args: Parameters<Instance['createPiWebSocketRequestPreparer']>): ReturnType<Instance['createPiWebSocketRequestPreparer']> {
  return desktopPiWebSocket.createPiWebSocketRequestPreparer(...args);
}

export function piWebSocketTransforms(...args: Parameters<Instance['piWebSocketTransforms']>): ReturnType<Instance['piWebSocketTransforms']> {
  return desktopPiWebSocket.piWebSocketTransforms(...args);
}
