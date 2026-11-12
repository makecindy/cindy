
// The bridge itself lives in anthropicResponsesBridgeHostCore.ts (shared with the Node
// Host). This module builds the single Desktop instance; its ports resolve the Desktop
// modules when called, never when this module loads.
import { createAnthropicResponsesBridgeHost } from './anthropicResponsesBridgeHostCore.js';
import { subscriptionRequestAllowsFast } from './subscription-fast-request-policy.js';
import { isXaiSubscriptionProviderId } from './subscription-account-auth.js';
import { app } from 'electron';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { getGrokAccessToken, peekGrokAccessToken } from './grok-oauth-login.desktop.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';
import { chatgptAccountIdFromTokens, desktopCodexAuthAdapter } from './auth-adapters.js';
import { codexAccountHome, codexAccountState, invalidateCodexAccount, isOpenAiSubscriptionProviderId } from './codex-account-auth.desktop.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';

const desktopBridge = createAnthropicResponsesBridgeHost({
  subscriptionRequestAllowsFast: (...args) => subscriptionRequestAllowsFast(...args),
  isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args),
  app: { getPath: (name) => app.getPath(name) },
  outboundFetch: (...args) => outboundFetch(...args),
  getGrokAccessToken: (...args) => getGrokAccessToken(...args),
  peekGrokAccessToken: (...args) => peekGrokAccessToken(...args),
  invalidateXaiBridgeAuth: (...args) => invalidateXaiBridgeAuth(...args),
  chatgptAccountIdFromTokens: (...args) => chatgptAccountIdFromTokens(...args),
  desktopCodexAuthAdapter: { getAccessToken: (...args) => desktopCodexAuthAdapter.getAccessToken(...args), invalidate: (...args) => desktopCodexAuthAdapter.invalidate(...args), captureOAuthDispatchProof: (...args) => desktopCodexAuthAdapter.captureOAuthDispatchProof(...args) },
  codexAccountHome: (...args) => codexAccountHome(...args),
  codexAccountState: (...args) => codexAccountState(...args),
  invalidateCodexAccount: (...args) => invalidateCodexAccount(...args),
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
  recordXaiRateLimitSnapshot: (...args) => recordXaiRateLimitSnapshot(...args),
});
type Instance = typeof desktopBridge;

export type PiNativeSubscriptionHandlerDeps = NonNullable<Parameters<Instance['getPiNativeSubscriptionHandler']>[2]>;

export function clearChatgptBridgeCredentialCache(...args: Parameters<Instance['clearChatgptBridgeCredentialCache']>): ReturnType<Instance['clearChatgptBridgeCredentialCache']> {
  return desktopBridge.clearChatgptBridgeCredentialCache(...args);
}

export function invalidateChatgptBridgeAuth(...args: Parameters<Instance['invalidateChatgptBridgeAuth']>): ReturnType<Instance['invalidateChatgptBridgeAuth']> {
  return desktopBridge.invalidateChatgptBridgeAuth(...args);
}

export function getChatgptBridgeAuth(...args: Parameters<Instance['getChatgptBridgeAuth']>): ReturnType<Instance['getChatgptBridgeAuth']> {
  return desktopBridge.getChatgptBridgeAuth(...args);
}

export function getChatgptBridgeAuthForDispatch(...args: Parameters<Instance['getChatgptBridgeAuthForDispatch']>): ReturnType<Instance['getChatgptBridgeAuthForDispatch']> {
  return desktopBridge.getChatgptBridgeAuthForDispatch(...args);
}

export function getResponsesBridgeHandler(...args: Parameters<Instance['getResponsesBridgeHandler']>): ReturnType<Instance['getResponsesBridgeHandler']> {
  return desktopBridge.getResponsesBridgeHandler(...args);
}

export function getPiNativeSubscriptionHandler(...args: Parameters<Instance['getPiNativeSubscriptionHandler']>): ReturnType<Instance['getPiNativeSubscriptionHandler']> {
  return desktopBridge.getPiNativeSubscriptionHandler(...args);
}
