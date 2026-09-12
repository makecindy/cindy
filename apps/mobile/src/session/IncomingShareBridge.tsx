import { useEffect } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { useRouter, useSegments } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import {
  receiveIncomingShare,
  useIncomingShareBatch,
} from '@/session/incomingShare';

/**
 * 根级 Share Extension 桥：未登录时先保留 App Group payload；登录、路由都就绪后
 * 再进入新建任务。真正清除原生 payload 的时机由新建页领取成功后触发。
 */
export function IncomingShareBridge() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const batch = useIncomingShareBatch();
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    let subscriptions: Array<{ remove(): void }> = [];
    void import('expo-sharing').then((sharing) => {
      if (!active) return;
      const refresh = () => {
        // Older development clients lack the native App Group. Inbound sharing
        // must not prevent startup. Local files need no async/network resolver.
        try {
          receiveIncomingShare(sharing);
        } catch {
          // Inbound sharing is unavailable in this native binary.
        }
      };
      subscriptions = [
        AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); }),
        Linking.addEventListener('url', refresh),
      ];
      refresh();
    }).catch(() => undefined);
    return () => {
      active = false;
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, []);

  useEffect(() => {
    if (
      !batch
      || !auth.initialized
      || !auth.isAuthenticated
      || segments[0] === '(auth)'
      || segments.join('/') === 'sessions/new'
    ) {
      return;
    }
    router.navigate('/sessions/new');
  }, [auth.initialized, auth.isAuthenticated, batch, router, segments]);

  return null;
}
