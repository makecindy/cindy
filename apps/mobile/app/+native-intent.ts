// expo-router 深链拦截。
//
// auth-server 回调 cindycn://auth / cindy://auth 与 Share Extension 的
// cindycn://expo-sharing / cindy://expo-sharing 都没有对应路由页,默认会落到
// expo-router 的 +not-found(「Unmatched Route」白屏)。这里分别把它们重定向到首页与
// 新建任务页；分享 payload 由根级 IncomingShareBridge 独立领取。
//
// 实际的 PKCE code 交换**不依赖路由**:由 src/auth/AuthContext.tsx 的 Linking.addEventListener /
// getInitialURL 监听器独立捕获原始 URL 并完成(见其 handleDeepLink)。本文件只负责别让路由 404。
//
// 系统浏览器认证与微信原生授权的回跳都可能同时送到 Router；微信 SDK 的
// oauth / refreshToken 及 Universal Link 校验回跳由原生 delegate 消费，也不对应页面。本文件仅控制导航，
// 不交换或解析授权票据，不更改原生 SDK 的 state 校验。
//
// 纯 JS(不进 @expo/fingerprint / 不改 runtimeVersion),可随热更下发。

import { WECHAT_APP_ID, WECHAT_UNIVERSAL_LINK } from '@/config/env';
import { isWechatSdkCallback } from '@/auth/wechatCallback';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // OpenSDK 的授权及 Universal Link 校验回调也会被 Expo Linking 广播给 Router。
    // 它们由原生 delegate 消费，不能当页面显示（更不能在 404 中展示 code）。
    // 不把微信 code 交给 auth-server 的 /auth PKCE 交换：两者不是同一种票据。
    if (isWechatSdkCallback(path, {
      appId: WECHAT_APP_ID,
      universalLink: WECHAT_UNIVERSAL_LINK,
    })) return '/';
    // path 可能是完整 URL('cindycn://auth?code=...')或路径('/auth?code=...'),统一取出 pathname。
    const noScheme = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '/');
    const pathname = noScheme.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    // 命中 OAuth 回调 → 回首页；Share Extension → 新建任务；其余深链原样放行。
    if (pathname === '/auth') return '/';
    if (pathname === '/expo-sharing') return '/sessions/new';
    return path;
  } catch {
    return path;
  }
}
