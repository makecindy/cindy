import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  clearUsageWidgetState,
  onUsageWidgetBackgroundRefresh,
  readUsageWidgetStore,
  refreshUsageWidgets,
  usageWidgetsSupported,
} from './usageWidgetSync';

// The computers rebuild their overview every few minutes; the widgets need no more.
const REFRESH_MS = 5 * 60_000;
/** iOS gives a background refresh about 30 seconds; leave it some to finish. */
const BACKGROUND_BUDGET_MS = 25_000;

/**
 * Keeps the iOS and Android home-screen widgets fed while the app is active, and on iOS also when
 * the system grants background refresh time (renders nothing). Widgets cannot reach a computer
 * themselves, so the app hands them each computer's latest overview.
 */
export function UsageWidgetBridge() {
  const { invoke, readDeviceList, status, holdBackgroundConnection } = useDeviceLink();
  const { initialized, isAuthenticated, accountGeneration, user } = useAuth();
  const userId = user?.id ?? null;
  const refreshId = useRef(0);
  const latest = useRef({ invoke, readDeviceList, accountGeneration, userId, holdBackgroundConnection });
  latest.current = { invoke, readDeviceList, accountGeneration, userId, holdBackgroundConnection };

  // Another account (or none) must never see the previous account's quota on the home screen.
  // The same account keeps its snapshot across restarts, so an offline computer still shows it.
  useEffect(() => {
    if (!initialized) return;
    if (!isAuthenticated) clearUsageWidgetState();
    else if (userId) {
      const stored = readUsageWidgetStore();
      if (stored && stored.accountId !== userId) clearUsageWidgetState();
    }
  }, [initialized, isAuthenticated, userId]);

  useEffect(() => {
    if (Platform.OS === 'web' || !userId || !isAuthenticated || status !== 'online') return;
    const generation = accountGeneration;
    let active = true;
    let pending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (pending || AppState.currentState !== 'active') return;
      pending = true;
      try {
        const id = ++refreshId.current;
        await refreshUsageWidgets(latest, generation, () => active && id === refreshId.current);
      } catch {
        // Keep the last snapshot; the widgets show how old it is.
      } finally {
        pending = false;
      }
    };
    const resume = () => {
      clearInterval(timer);
      timer = undefined;
      if (AppState.currentState !== 'active') return;
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
    };
    resume();
    const subscription = AppState.addEventListener('change', resume);
    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [isAuthenticated, accountGeneration, status, userId]);

  // Background refresh: the connection is held only for this one read, like a notification button.
  useEffect(() => {
    if (!usageWidgetsSupported || !isAuthenticated) return;
    const generation = accountGeneration;
    return onUsageWidgetBackgroundRefresh(async () => {
      const id = ++refreshId.current;
      let active = true;
      const release = latest.current.holdBackgroundConnection?.() ?? (() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          refreshUsageWidgets(latest, generation, () => active && id === refreshId.current),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => { active = false; resolve(false); }, BACKGROUND_BUDGET_MS); }),
        ]);
      } finally {
        active = false;
        clearTimeout(timer);
        release();
      }
    });
  }, [isAuthenticated, accountGeneration]);

  return null;
}
