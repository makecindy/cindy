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
 * 再选择任务或伙伴。目标编辑器领取成功后才清除原生 payload。
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
      let refreshing = false;
      let refreshQueued = false;
      const refresh = () => {
        refreshQueued = true;
        if (refreshing) return;
        refreshing = true;
        void (async () => {
          try {
            // Foreground and URL are notifications of the same native inbox.
            // Serialize them; neither event can reset a user's chosen target.
            while (active && refreshQueued) {
              refreshQueued = false;
              try {
                const { cleanupExpiredIncomingShares } = await import('@/session/incomingShareCleanup');
                await cleanupExpiredIncomingShares();
              } catch { /* Older binaries may not expose the shared container. */ }
              if (!active) return;
              try { await receiveIncomingShare(sharing); }
              catch { /* Preserve the native inbox for the next foreground/retry. */ }
            }
          } finally { refreshing = false; }
        })();
      };
      subscriptions = [
        AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); }),
        Linking.addEventListener('url', ({ url }) => {
          if (/^[a-z][a-z0-9+.-]*:\/\/expo-sharing(?:[/?#]|$)/i.test(url)) refresh();
        }),
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
      || !!batch.destination
      || presentedBatchId.current === batch.id
    ) {
      return;
    }
    if (segments.join('/') === 'incoming-share') {
      presentedBatchId.current = batch.id;
      return;
    }
    // A storage error leaves the batch pending. Let the user leave the error
    // screen and return to retry instead of repeatedly forcing it back open.
    presentedBatchId.current = batch.id;
    router.navigate('/incoming-share');
  }, [auth.initialized, auth.isAuthenticated, batch, router, segments]);

  return null;
}
