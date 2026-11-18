import { NotificationReconciliationBridge } from './NotificationReconciliationBridge';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import { useMobileAgentNetPreferences } from '@/device-link/agentNetPreferences';
import { mobileAgentNetPushScope, mobileAgentNetPushSelected, subscribeMobileAgentNetPushScope } from '@/device-link/agentNetPushRegistry';
import Notifications from './nativeNotifications';
import { ChatBackgroundBridge } from './ChatBackgroundBridge';
import { isNotificationRouteVisible } from './notificationBadge';
import { notificationRecoveryRoute, parseNotificationResponseDeepLink } from './pushRegistrationModel';
import { handleNotificationActionResponse } from './notificationActionRunner';
import {
  configureForegroundNotificationBehavior,
  registerNotificationActionCategories,
  isPushSupported,
  readPushEnabled,
  retryPendingUnregister,
  syncPushRegistration,
} from './pushNotifications';

/** 已消费点击的去重键(模块级:组件重挂/Provider 重建也不重复路由)。 */
const consumedNotificationResponseKeys = new Set<string>();
type NotificationResponse = Parameters<
  Parameters<typeof Notifications.addNotificationResponseReceivedListener>[0]
>[0];

/**
 * 移动推送的运行时桥(挂在 AuthProvider 内、导航树旁,不渲染任何 UI):
 *
 * 1. 登录后按本机开关同步 token 注册(启动补偿:上次注册失败/换账号后自愈);
 * 2. APNs token 轮换时重新上报;
 * 3. 通知点击(前台/后台/冷启动)→ 解析 APNs / Expo 深链 → 路由到对应会话;
 * 4. 只在前台正阅读对应群聊／话题时压掉横幅。
 */
export function PushNotificationsBridge() {
  const auth = useAuth();
  const { i18n: { language } } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { threadRootId, deviceId } = useGlobalSearchParams<{ threadRootId?: string; deviceId?: string }>();
  const visibleChat = useRef({ pathname, threadRootId, deviceId });
  visibleChat.current = { pathname, threadRootId, deviceId };
  const routerRef = useRef(router);
  routerRef.current = router;
  /** 冷启动点通知时 auth 可能未就绪,先存下待路由的深链。 */
  const pendingDeepLinkRef = useRef<string | null>(null);
  const pendingAgentNetScopeRef = useRef<string | null>(null);
  const authStateRef = useRef({
    initialized: auth.initialized,
    isAuthenticated: auth.isAuthenticated,
  });
  authStateRef.current = {
    initialized: auth.initialized,
    isAuthenticated: auth.isAuthenticated,
  };
  const apiFetchRef = useRef(auth.apiFetch);
  apiFetchRef.current = auth.apiFetch;
  // 自建中转下不登记 device-link 推送;切回官方中转后按本机开关重新同步一次。
  const selfHostedRelay = useSelfHostedRelay();
  const agentNetPreferences = useMobileAgentNetPreferences();

  useEffect(() => {
    if (!isPushSupported()) return;
    configureForegroundNotificationBehavior(route => {
      return AppState.currentState === 'active' && isNotificationRouteVisible(route, visibleChat.current);
    }, () => authStateRef.current.initialized && authStateRef.current.isAuthenticated);
  }, []);

  // 通知上的按钮(允许一次 / 拒绝 / 回复):按当前界面语言向系统登记,换语言后重新登记。
  useEffect(() => {
    if (!isPushSupported()) return;
    void registerNotificationActionCategories().catch(() => undefined);
  }, [language]);

  // 登录态就绪后同步注册状态(开关关闭 / 从未注册时是 no-op)
  useEffect(() => {
    if (!isPushSupported()) return;
    if (!auth.initialized || !auth.isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      // 只用当前会话补偿当前区域的注销，再按本机开关同步注册状态。
      await retryPendingUnregister(apiFetchRef.current).catch(() => undefined);
      if (cancelled) return;
      const enabled = await readPushEnabled();
      if (cancelled || !enabled) return;
      await syncPushRegistration({ enabled, apiFetch: apiFetchRef.current }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.accountGeneration, auth.initialized, auth.isAuthenticated, auth.user, selfHostedRelay, agentNetPreferences.generation]);

  // APNs token 轮换 → 重新上报(仅开关开启且已登录时)
  useEffect(() => {
    if (!isPushSupported()) return;
    if (!auth.initialized || !auth.isAuthenticated) return;
    let lastToken: string | undefined;
    let cancelled = false;
    const sub = Notifications.addPushTokenListener((deviceToken) => {
      if (typeof deviceToken.data !== 'string' || !deviceToken.data.trim()) return;
      const token = `${deviceToken.type}:${deviceToken.data}`;
      if (lastToken === token) return;
      lastToken = token;
      void (async () => {
        const enabled = await readPushEnabled();
        if (cancelled) return;
        if (!enabled) { if (lastToken === token) lastToken = undefined; return; }
        const result = await syncPushRegistration({ enabled, apiFetch: apiFetchRef.current, deviceToken });
        if (result !== 'registered' && lastToken === token) lastToken = undefined;
      })().catch(() => { if (lastToken === token) lastToken = undefined; });
    });
    return () => { cancelled = true; sub.remove(); };
  }, [auth.accountGeneration, auth.initialized, auth.isAuthenticated]);

  const flushPendingDeepLink = useCallback((): void => {
    const target = pendingDeepLinkRef.current;
    if (!target) return;
    const { initialized, isAuthenticated } = authStateRef.current;
    if (!initialized || !isAuthenticated) return; // 待 auth 就绪后由下方 effect 重放
    const scope = pendingAgentNetScopeRef.current;
    if (scope) {
      const current = mobileAgentNetPushScope();
      if (!current && mobileAgentNetPushSelected()) return; // Wait for this account's V2 identity.
      if (scope !== current) { pendingDeepLinkRef.current = null; pendingAgentNetScopeRef.current = null; return; }
    }
    pendingDeepLinkRef.current = null;
    pendingAgentNetScopeRef.current = null;
    routerRef.current.push(target as never);
  }, []);
  useEffect(() => subscribeMobileAgentNetPushScope(flushPendingDeepLink), [flushPendingDeepLink]);

  // 通知点击路由:后台点击经 response listener,冷启动 / 回前台经 last response 补偿
  useEffect(() => {
    if (!isPushSupported()) return;
    const consumeResponse = (response: NotificationResponse): void => {
      // A button on the alert (allow / deny / reply) is carried out in the background;
      // only an ordinary tap navigates.
      if (handleNotificationActionResponse(response)) return;
      const deepLink = parseNotificationResponseDeepLink(response);
      if (!deepLink) return;
      const identifier = response.notification.request.identifier;
      const dedupeKey = identifier ? `id:${identifier}` : `deepLink:${deepLink}`;
      if (consumedNotificationResponseKeys.has(dedupeKey)) return;
      consumedNotificationResponseKeys.add(dedupeKey);
      void Notifications.clearLastNotificationResponseAsync?.()?.catch(() => undefined);
      pendingDeepLinkRef.current = notificationRecoveryRoute(deepLink, dedupeKey);
      const data = response.notification.request.content.data;
      pendingAgentNetScopeRef.current = typeof data?.agentNetScope === 'string' ? data.agentNetScope : null;
      flushPendingDeepLink();
    };

    const readLastResponse = (): void => {
      void Notifications.getLastNotificationResponseAsync()
        .then((response) => {
          if (response) consumeResponse(response);
        })
        .catch(() => undefined);
    };

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      consumeResponse(response);
    });
    readLastResponse();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') readLastResponse();
    });
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [flushPendingDeepLink]);

  // auth 就绪后重放冷启动 / 点击期间暂存的深链。监听本身保持挂载，避免 auth
  // 状态变化重建 effect 时与 last-response 读取发生竞态。
  useEffect(() => {
    flushPendingDeepLink();
  }, [auth.initialized, auth.isAuthenticated, flushPendingDeepLink]);

  return <><ChatBackgroundBridge /><NotificationReconciliationBridge /></>;
}
