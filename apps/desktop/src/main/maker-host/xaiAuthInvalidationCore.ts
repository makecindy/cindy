
import {
  createXaiAuthInvalidationObserver,
  createXaiBridgeAuthInvalidator,
} from './xai-bridge-auth-invalidation.js';


export function createXaiAuthInvalidationHost(ports: {
  peekGrokAccessToken: typeof import('./grok-oauth-login.desktop.js').peekGrokAccessToken;
  recoverGrokAuthAfterRejection: typeof import('./grok-oauth-login.desktop.js').recoverGrokAuthAfterRejection;
}) {
const { peekGrokAccessToken, recoverGrokAuthAfterRejection } = ports;


/**
 * 凭证被作废并清空后的 UI 收尾(bootstrap 注入)。
 *
 * 用注入而不是直接 import maker-host/index 的 broadcast:那条路会在
 * index → proxy host → 本模块 之间成环。与 claude adapter 的
 * setOnInvalidatedBroadcast / setClaudeOAuthInvalidGrantHandler 同一模式。
 */
let _onLoggedOut: (providerId: string) => void = () => {}; function setXaiAuthInvalidatedHandler(cb: (providerId: string) => void): void {
  _onLoggedOut = cb;
}

/** 全局唯一的 xAI 凭证收口入口(两条 agent 链路共用)。 */
const createForAccount = (providerId: string) => createXaiBridgeAuthInvalidator({
  getCurrentAccessToken: async () => peekGrokAccessToken(providerId),
  recover: async (_reason, failedAccessToken) => {
    const outcome = await recoverGrokAuthAfterRejection(failedAccessToken, providerId);
    // 自动登出必须和手动登出一样即时反映到 UI,否则用户仍停在「显示已连接」的假状态 ——
    // 那正是本模块要消灭的东西。广播失败不影响凭证收口结论。
    if (outcome === 'logged_out') {
      try {
        _onLoggedOut(providerId);
      } catch {
        /* 广播是尽力而为:UI 最迟在下次 listProviders 现读时纠正 */
      }
    }
    return outcome;
  },
});

const invalidators = new Map<string, ReturnType<typeof createForAccount>>(); function invalidateXaiBridgeAuth(input: Parameters<ReturnType<typeof createForAccount>>[0], providerId = 'xai') {
  let invalidator = invalidators.get(providerId);
  if (!invalidator) { invalidator = createForAccount(providerId); invalidators.set(providerId, invalidator); }
  return invalidator(input);
} function createXaiProxyAuthInvalidationObserver(
  resolveProviderId?: (ctx: Parameters<ReturnType<typeof createXaiAuthInvalidationObserver>>[0]) => string | null,
): ReturnType<
  typeof createXaiAuthInvalidationObserver
> {
  return (ctx) => {
    const providerId = resolveProviderId?.(ctx) ?? 'xai';
    return createXaiAuthInvalidationObserver((failure) => invalidateXaiBridgeAuth(failure, providerId))(ctx);
  };
}
return { setXaiAuthInvalidatedHandler, invalidateXaiBridgeAuth, createXaiProxyAuthInvalidationObserver };
}
