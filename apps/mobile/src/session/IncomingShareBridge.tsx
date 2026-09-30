import { useEffect, useRef } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { useRouter, useSegments } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  receiveIncomingShare,
  useIncomingShareBatch,
  watchIncomingShareAccount,
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
  const presentedBatchId = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    const initialOwner = getMobileAuthOwner();
    let stopWatchingAccount: (() => void) | undefined;
    let subscriptions: Array<{ remove(): void }> = [];
    void import('@/session/incomingShareNative').then((sharing) => {
      if (!active) return;
      stopWatchingAccount = watchIncomingShareAccount(sharing, initialOwner);
      const refresh = () => {
        void import('@/session/incomingShareCleanup')
          .then(({ cleanupExpiredIncomingShares }) => cleanupExpiredIncomingShares())
          .catch(() => undefined)
          .then(() => {
            if (!active) return;
            // Sweep before staging, so an expired native copy cannot start a new
            // upload concurrently with deletion. The native adapter filters missing
            // copies before they can trigger navigation.
            try {
              receiveIncomingShare(sharing);
            } catch {
              // Inbound sharing is unavailable in older native binaries.
            }
          });
      };
      subscriptions = [
        AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); }),
        Linking.addEventListener('url', refresh),
        { remove: subscribeMobileAuthOwner(() => {
          if (!getMobileAuthOwner().switching && AppState.currentState === 'active') refresh();
        }) },
      ];
      refresh();
    }).catch(() => undefined);
    return () => {
      active = false;
      stopWatchingAccount?.();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, []);

  useEffect(() => {
    if (!batch) {
      presentedBatchId.current = null;
      return;
    }
    if (
      !auth.initialized
      || !auth.isAuthenticated
      || segments[0] === '(auth)'
      || presentedBatchId.current === batch.id
    ) {
      return;
    }
    if (segments.join('/') === 'sessions/new') {
      presentedBatchId.current = batch.id;
      return;
    }
    // A storage error leaves the batch pending. Let the user leave the error
    // screen and return to retry instead of repeatedly forcing it back open.
    presentedBatchId.current = batch.id;
    router.navigate('/sessions/new');
  }, [auth.initialized, auth.isAuthenticated, batch, router, segments]);

  return null;
}
