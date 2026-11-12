import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useChatClient } from '@/chat/useChatServer';
import { useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import { getMobileEndpointForRealm } from '@/config/env';
import Native from '../../modules/cindy-notification-state';
import Notifications from './nativeNotifications';
import { reconcileDeliveredNotifications } from './notificationReconciliation';
import { isPushSupported } from './pushNotifications';

/** Reconcile delivered IDs after foreground/reconnect; never infer read from Home pagination. */
export function NotificationReconciliationBridge() {
  const auth = useAuth();
  const chat = useChatClient();
  const selfHosted = useSelfHostedRelay() !== null;
  useEffect(() => {
    if (!isPushSupported() || !auth.initialized || !auth.isAuthenticated) return;
    let disposed = false;
    let running = false;
    let requested = false;
    let lastStartedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const current = () => !disposed && chat.current() && AppState.currentState === 'active';
    const reconcile = async () => {
      if (!current()) return;
      if (running) { requested = true; return; }
      running = true;
      lastStartedAt = Date.now();
      try {
        await reconcileDeliveredNotifications({
          current,
          presented: () => Notifications.getPresentedNotificationsAsync(),
          resolve: async items => {
            const ids: string[] = [];
            const tasks = items.filter(item => !item.chat && item.recipientId === auth.user?.id);
            if (!selfHosted && tasks.length) {
              try {
                const result = await auth.apiFetch<{ ids: string[] }>('/api/device-link/notification-dismissals/query', {
                  baseUrl: getMobileEndpointForRealm(chat.realm, 'deviceLinkApiBaseUrl'), method: 'POST',
                  body: { ids: tasks.map(item => item.id) }, signal: abort.signal,
                  assertCurrent: () => { if (!current()) throw new Error('NOTIFICATION_LIFETIME_ENDED'); },
                });
                if (result && Array.isArray(result.ids)) ids.push(...result.ids.map(id => `${auth.user?.id}:${id}`));
              } catch { /* Task service failure must not block chat retirement. */ }
            }
            const messages = items.filter(item => item.chat);
            if (messages.length && current()) {
              try {
                const self = await chat.client.me();
                if (!current()) return ids;
                const own = messages.filter(item => item.recipientId === self);
                if (own.length) {
                  const result = await chat.request<{ recipientId: string; ids: string[] }>('/push/retired', 'POST',
                    { ids: own.map(item => item.id) }, undefined, abort.signal);
                  if (result?.recipientId === self && Array.isArray(result.ids)) ids.push(...result.ids.map(id => `${self}:${id}`));
                }
              } catch { /* Chat discovery/query failure must preserve task results and later batches. */ }
            }
            return ids;
          },
          retire: async items => {
            for (const recipient of new Set(items.map(item => item.recipientId))) {
              const own = items.filter(item => item.recipientId === recipient);
              if (!current()) return;
              if (Native) await Native.retire(recipient, own.map(item => item.id));
              else for (const item of own) { if (!current()) return; await Notifications.dismissNotificationAsync(item.identifier); }
            }
          },
        });
      } catch { /* Offline/old servers retain notifications; a later foreground repairs. */ }
      finally { running = false; if (requested) { requested = false; schedule(); } }
    };
    const schedule = () => {
      if (!current() || timer) return;
      timer = setTimeout(() => { timer = undefined; void reconcile(); }, Math.max(500, lastStartedAt + 60_000 - Date.now()));
    };
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') { clearTimeout(timer); timer = undefined; lastStartedAt = 0; schedule(); } });
    const received = Notifications.addNotificationReceivedListener(schedule);
    const heartbeat = setInterval(schedule, 60_000);
    schedule();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); clearInterval(heartbeat); foreground.remove(); received.remove(); };
  }, [auth.initialized, auth.isAuthenticated, auth.accountGeneration, auth.user?.id, auth.apiFetch, chat, selfHosted]);
  return null;
}
