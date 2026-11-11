/** Platform assembly for the shared service. */
/**
 * xai-auth-invalidation-host —— xAI 凭证失效收口的 host 接线(单例)。
 *
 * claude-code(anthropic-responses-bridge 的 onUpstreamError)与 codex(codex-proxy 的
 * responseObserver)两条链路必须共用同一个 invalidator 实例:并发合并是按 failed token
 * 做的,各建一个实例就会各刷各的,把 refresh_token 的轮换互相作废。
 */

import { peekGrokAccessToken, recoverGrokAuthAfterRejection } from './grok-oauth-login.desktop.js';
import { createXaiAuthInvalidationHost } from './xaiAuthInvalidationCore.js';
export const { setXaiAuthInvalidatedHandler, invalidateXaiBridgeAuth, createXaiProxyAuthInvalidationObserver } = createXaiAuthInvalidationHost({
  peekGrokAccessToken: (...args) => peekGrokAccessToken(...args),
  recoverGrokAuthAfterRejection: (...args) => recoverGrokAuthAfterRejection(...args),
});
