import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { parseNotificationDeepLink } from './pushRegistrationModel';
import {
  configureForegroundNotificationBehavior,
  isPushSupported,
  readPushEnabled,
  retryPendingUnregister,
  syncPushRegistration,
} from './pushNotifications';

/** 冷启动 last-response 的已消费标记(模块级:组件重挂/Provider 重建也不重复路由)。 */
const consumedLastResponseIds = new Set<string>();

/**
 * 移动推送的运行时桥(挂在 AuthProvider 内、导航树旁,不渲染任何 UI):
 *
 * 1. 登录后按本机开关同步 token 注册(启动补偿:上次注册失败/换账号后自愈);
 * 2. APNs token 轮换时重新上报;
 * 3. 通知点击(前台/后台/冷启动)→ 校验 data.deepLink → 路由到对应会话;
 * 4. 前台压掉系统横幅。
 */
export function PushNotificationsBridge() {
  const auth = useAuth();
  const router = useRouter();
  /** 冷启动点通知时 auth 可能未就绪,先存下待路由的深链。 */
  const pendingDeepLinkRef = useRef<string | null>(null);
  const apiFetchRef = useRef(auth.apiFetch);
  apiFetchRef.current = auth.apiFetch;

  useEffect(() => {
    if (!isPushSupported()) return;
    configureForegroundNotificationBehavior();
  }, []);

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
  }, [auth.initialized, auth.isAuthenticated, auth.user]);

  // APNs token 轮换 → 重新上报(仅开关开启且已登录时)
  useEffect(() => {
    if (!isPushSupported()) return;
    if (!auth.initialized || !auth.isAuthenticated) return;
    const sub = Notifications.addPushTokenListener(() => {
      void (async () => {
        const enabled = await readPushEnabled();
        if (!enabled) return;
        await syncPushRegistration({ enabled, apiFetch: apiFetchRef.current }).catch(
          () => undefined,
        );
      })();
    });
    return () => sub.remove();
  }, [auth.initialized, auth.isAuthenticated]);

  // 通知点击路由:后台点击经 response listener,冷启动经 last response 补偿
  useEffect(() => {
    if (!isPushSupported()) return;
    const routeTo = (deepLink: string | null): void => {
      if (!deepLink) return;
      pendingDeepLinkRef.current = deepLink;
      flushPendingDeepLink();
    };
    const flushPendingDeepLink = (): void => {
      const target = pendingDeepLinkRef.current;
      if (!target) return;
      if (!auth.initialized || !auth.isAuthenticated) return; // 待 auth 就绪后由下方 effect 重放
      pendingDeepLinkRef.current = null;
      router.push(target as never);
    };
    // effect 因 auth 就绪重跑时,冷启动阶段暂存的深链在此重放——last response
    // 已被上一轮消费/清除,不能依赖再次读取它来触发
    flushPendingDeepLink();
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      routeTo(parseNotificationDeepLink(response.notification.request.content.data));
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      // last response 会一直返回同一次点击(effect 因 auth 变化重跑、组件重挂时会
      // 再次读到):按 request.identifier 去重,消费后清掉系统侧记录,避免用户处理
      // 完通知后又被重复推回旧会话。
      const identifier = response.notification.request.identifier;
      if (identifier && consumedLastResponseIds.has(identifier)) return;
      if (identifier) consumedLastResponseIds.add(identifier);
      void Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined);
      routeTo(parseNotificationDeepLink(response.notification.request.content.data));
    });
    return () => sub.remove();
    // auth 状态变化时重跑以重放 pending 深链(冷启动点通知 → 登录恢复完成 → 进会话)
  }, [auth.initialized, auth.isAuthenticated, router]);

  return null;
}
