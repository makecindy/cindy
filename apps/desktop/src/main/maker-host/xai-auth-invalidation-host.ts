/**
 * xai-auth-invalidation-host —— xAI 凭证失效收口的 host 接线(单例)。
 *
 * claude-code(anthropic-responses-bridge 的 onUpstreamError)与 codex(codex-proxy 的
 * responseObserver)两条链路必须共用同一个 invalidator 实例:并发合并是按 failed token
 * 做的,各建一个实例就会各刷各的,把 refresh_token 的轮换互相作废。
 */

import { peekGrokAccessToken, recoverGrokAuthAfterRejection } from './grok-oauth-login.js';
import {
  createXaiAuthInvalidationObserver,
  createXaiBridgeAuthInvalidator,
} from './xai-bridge-auth-invalidation.js';

/**
 * 凭证被作废并清空后的 UI 收尾(bootstrap 注入)。
 *
 * 用注入而不是直接 import maker-host/index 的 broadcast:那条路会在
 * index → proxy host → 本模块 之间成环。与 claude adapter 的
 * setOnInvalidatedBroadcast / setClaudeOAuthInvalidGrantHandler 同一模式。
 */
let _onLoggedOut: () => void = () => {};
export function setXaiAuthInvalidatedHandler(cb: () => void): void {
  _onLoggedOut = cb;
}

/** 全局唯一的 xAI 凭证收口入口(两条 agent 链路共用)。 */
export const invalidateXaiBridgeAuth = createXaiBridgeAuthInvalidator({
  getCurrentAccessToken: async () => peekGrokAccessToken(),
  recover: async (_reason, failedAccessToken) => {
    const outcome = await recoverGrokAuthAfterRejection(failedAccessToken);
    // 自动登出必须和手动登出一样即时反映到 UI,否则用户仍停在「显示已连接」的假状态 ——
    // 那正是本模块要消灭的东西。广播失败不影响凭证收口结论。
    if (outcome === 'logged_out') {
      try {
        _onLoggedOut();
      } catch {
        /* 广播是尽力而为:UI 最迟在下次 listProviders 现读时纠正 */
      }
    }
    return outcome;
  },
});

/** codex proxy 的 responseObserver 接线(与上面同一个 invalidator)。 */
export function createXaiProxyAuthInvalidationObserver(): ReturnType<
  typeof createXaiAuthInvalidationObserver
> {
  return createXaiAuthInvalidationObserver(invalidateXaiBridgeAuth);
}
