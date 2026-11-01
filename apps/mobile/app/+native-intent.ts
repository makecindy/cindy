// expo-router 深链拦截。
//
// auth-server 回调 cindycn://auth / cindy://auth 与 Share Extension 的
// cindycn://expo-sharing / cindy://expo-sharing 都没有对应路由页,默认会落到
// expo-router 的 +not-found(「Unmatched Route」白屏)。这里在冷启动时把认证回跳重定向到首页，热回跳保留当前页面；分享跳到
// 目标选择页由根级 IncomingShareBridge 在确认待领取 payload 后统一打开。
//
// 实际的 PKCE code 交换**不依赖路由**:由 src/auth/AuthContext.tsx 的 Linking.addEventListener /
// getInitialURL 监听器独立捕获原始 URL 并完成(见其 handleDeepLink)。本文件只负责别让路由 404。
//
// 系统浏览器认证与微信原生授权的回跳都可能同时送到 Router；微信 SDK 的
// oauth / refreshToken 及 Universal Link 校验回跳由原生 delegate 消费，也不对应页面。本文件仅控制导航，
// 不交换或解析授权票据，不更改原生 SDK 的 state 校验。
//
// 纯 JS(不进 @expo/fingerprint / 不改 runtimeVersion),可随热更下发。

import { clearSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';
import {
  isProviderShareLinkPath,
  PROVIDER_SHARE_LINK_ROUTE,
  receiveProviderShareLinkIntent,
} from '@/device-link/providerShareLinkIntent';
import { isRelayJoinPath, RELAY_JOIN_ROUTE, receiveRelayJoinIntent } from '@/device-link/relayJoinIntent';
import { WECHAT_APP_ID, WECHAT_UNIVERSAL_LINK } from '@/config/env';
import { isWechatSdkCallback } from '@/auth/wechatCallback';
import { isChatInviteLinkPath, receiveChatInviteLink } from '@/chat/chatInviteIntent';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    // OpenSDK 的授权及 Universal Link 校验回调也会被 Expo Linking 广播给 Router。
    // 它们由原生 delegate 消费，不能当页面显示（更不能在 404 中展示 code）。
    // 不把微信 code 交给 auth-server 的 /auth PKCE 交换：两者不是同一种票据。
    if (isWechatSdkCallback(path, {
      appId: WECHAT_APP_ID,
      universalLink: WECHAT_UNIVERSAL_LINK,
    })) return '/';
    // Group invitations stay in memory across login. A warm link preserves the
    // current page; the single root Host presents the invitation after auth.
    if (receiveChatInviteLink(path)) return initial ? '/' : null;
    // 供应商分享链接只能在电脑上申请:手机只显示「请在电脑上打开」的提示页。口令不进路由
    // 状态与诊断(提示页从内存取走可复制的链接),不合法的链接同样落到提示页、什么都不留。
    if (receiveProviderShareLinkIntent(path)) return PROVIDER_SHARE_LINK_ROUTE;
    // 加入自建中转(扫电脑上的二维码):加入码只留在内存,加入页不带参数;不合法的链接同样
    // 落到加入页显示「链接无效」,什么都不留。
    if (receiveRelayJoinIntent(path)) return RELAY_JOIN_ROUTE;
    const invitationUrl = /^\/(?:shared-session|shared-task\/join)\?/.test(path) ? `cindy:/${path}` : path;
    if (receiveSharedTaskInvitationIntent(invitationUrl)) return '/shared-session';
    // path 可能是完整 URL('cindycn://auth?code=...')或路径('/auth?code=...'),统一取出 pathname。
    const noScheme = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '/');
    const pathname = noScheme.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    // Shared task links use the stable cross-client contract
    // cindy://session/<id>?device=<deviceId>&message=<clientId>, while Expo's
    // page route is plural and reads deviceId/focusClientId.
    if (pathname === '/session' || pathname.startsWith('/session/')) {
      const match = /^\/session\/([^/]+)$/.exec(pathname);
      if (!match) return initial ? '/' : null;

      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]);
      } catch {
        return initial ? '/' : null;
      }
      if (!sessionId || /[\\/\u0000-\u001f\u007f]/.test(sessionId)) return initial ? '/' : null;

      const fragmentIndex = noScheme.indexOf('#');
      const pathAndQuery = fragmentIndex < 0 ? noScheme : noScheme.slice(0, fragmentIndex);
      const fragment = fragmentIndex < 0 ? '' : noScheme.slice(fragmentIndex);
      const queryIndex = pathAndQuery.indexOf('?');
      const query = queryIndex < 0 ? '' : pathAndQuery.slice(queryIndex + 1);
      const params = new URLSearchParams(query);
      const hasDeviceId = params.has('deviceId');
      const hasFocusClientId = params.has('focusClientId');
      const normalizedParams = new URLSearchParams();
      for (const [key, value] of params) {
        if (key === 'device') {
          if (!hasDeviceId) normalizedParams.append('deviceId', value);
        } else if (key === 'message') {
          if (!hasFocusClientId) normalizedParams.append('focusClientId', value);
        } else {
          normalizedParams.append(key, value);
        }
      }

      const normalizedQuery = normalizedParams.toString();
      return `/sessions/${encodeURIComponent(sessionId)}${normalizedQuery ? `?${normalizedQuery}` : ''}${fragment}`;
    }
    // OAuth 冷启动回首页；热回跳不导航，保留正在处理授权的页面。
    // PKCE 仍由 AuthProvider 的独立 Linking 监听处理。其余深链沿用原规则。
    if (pathname === '/auth') return initial ? '/' : null;
    // A restored launch URL is not proof of an unconsumed share. On cold start,
    // let IncomingShareBridge navigate only after reading an actual pending batch.
    // Warm callbacks must not race that bridge with a second navigation.
    if (pathname === '/expo-sharing') return initial ? '/' : null;
    // Invalid invitations must not leave secrets in router state or diagnostics.
    if (pathname === '/shared-session' || pathname === '/shared-task/join') {
      clearSharedTaskInvitationIntent();
      return '/shared-session';
    }
    return path;
  } catch {
    if (isChatInviteLinkPath(path)) return initial ? '/' : null;
    // 分享口令与中转加入码绝不随原始链接进路由状态。
    if (isProviderShareLinkPath(path)) return PROVIDER_SHARE_LINK_ROUTE;
    return isRelayJoinPath(path) ? RELAY_JOIN_ROUTE : path;
  }
}
