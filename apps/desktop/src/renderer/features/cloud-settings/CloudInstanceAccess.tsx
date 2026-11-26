import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isForeground, onForegroundChange } from './foreground';
import { cloudBusyRetryAfterMs } from '../../../shared/cloudSettingsErrors';
import { useAuth } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

type Access = 'checking' | 'allowed' | 'hidden';
const CloudInstanceAccessContext = createContext<Access>('hidden');
// Allowed for this account, but the latest recheck could not reach the service.
const CloudInstanceAccessUnverifiedContext = createContext(false);
const READ_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/** Presentation only. Main holds credentials; CIS still authorizes every action.
 * Only the dedicated capability response confirms management/placement access.
 * Never infer permission from login mode, organization names or cached devices.
 * A window without the cloud bridge, or a region with no cloud instance service, makes no
 * checks: Main says so once per account and the provider then stays quiet. */
export function CloudInstanceAccessProvider({ children }: { children: ReactNode }) {
  const { mode, isAuthenticated, isInitializing, canEnterApp, dataOwnerId, dataOwnerGeneration } =
    useAuth();
  const available = window.electronAPI?.cloudSettings !== undefined;
  const scope =
    available && mode === 'cloud' && isAuthenticated && !isInitializing && canEnterApp && dataOwnerId
      ? JSON.stringify([dataOwnerId, dataOwnerGeneration])
      : null;
  const [result, setResult] = useState<{ scope: string; access: Access; unverified?: boolean } | null>(null);

  useEffect(() => {
    // Read here, not as a dependency: only the account starts a new check, never the bridge's identity.
    const bridge = window.electronAPI?.cloudSettings;
    if (!scope || !bridge) {
      setResult(null);
      return;
    }
    const owner = getDataOwnerGeneration();
    let live = true;
    let stopListening = () => {};
    let inFlight = false;
    let lastDecisionAt = -Infinity;
    let retryIndex = 0;
    let retryTimer: number | undefined;
    // The service's earliest next check after it throttled one.
    let notBefore = 0;
    const current = () => live && isDataOwnerGenerationCurrent(owner);
    const refresh = async () => {
      if (inFlight || !current() || Date.now() - lastDecisionAt < 5_000 || Date.now() < notBefore) return;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      inFlight = true;
      try {
        // Main verifies the committed identity; CIS derives admission from its
        // current policy, without listing instances, waking or allocating one.
        const decision = await bridge.instanceAccess({});
        if (current()) {
          retryIndex = 0;
          lastDecisionAt = Date.now();
          setResult({ scope, access: decision.allowed ? 'allowed' : 'hidden' });
        }
      } catch (error) {
        // A rejected or unavailable check is not permission to display the feature. An account
        // already allowed keeps its open pages, with saving paused, while the service is out of
        // reach; a denial, a scope change or another account removes them.
        if (current()) {
          const message = String((error as Error | undefined)?.message);
          const throttled = message.includes('CLOUD_SETTINGS_BUSY');
          const unreachable = throttled || message.includes('[CLOUD_SETTINGS_UNAVAILABLE]');
          setResult((previous) => unreachable && previous?.scope === scope && previous.access === 'allowed'
            ? { scope, access: 'allowed', unverified: true }
            : { scope, access: 'hidden' });
          // No cloud instance service in this region: nothing to check again for this account.
          if (String((error as Error | undefined)?.message).includes('[CLOUD_SETTINGS_UNSUPPORTED]')) {
            stopListening();
            return;
          }
          // Throttled: check again once the wait is over, on the next check while the window is in
          // front (interval, focus, coming back online or to the front).
          if (throttled) {
            notBefore = Date.now() + (cloudBusyRetryAfterMs(message) ?? 60_000);
            return;
          }
          // The committed auth projection may reach Renderer before Main releases
          // its owner-transition fence. Only that is retried quickly, without relying on
          // focus or visibility events. Explicit denial above never starts a retry.
          if (!message.includes('CLOUD_SETTINGS_SCOPE_CHANGED')) return;
          const delay = READ_RETRY_DELAYS_MS[retryIndex++];
          if (delay !== undefined) retryTimer = window.setTimeout(() => void refresh(), delay);
        }
      } finally {
        inFlight = false;
      }
    };
    const visible = () => {
      if (isForeground()) void refresh();
    };
    const timer = window.setInterval(visible, 60_000);
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    const stopFollowing = onForegroundChange(visible);
    stopListening = () => {
      window.clearInterval(timer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      stopFollowing();
    };
    void refresh();
    return () => {
      live = false;
      stopListening();
    };
  }, [scope]);

  // Hide synchronously on account/generation changes, before effect cleanup.
  const access = !scope ? 'hidden' : result?.scope === scope ? result.access : 'checking';
  const unverified = access === 'allowed' && result?.unverified === true;
  return (
    <CloudInstanceAccessContext.Provider value={access}>
      <CloudInstanceAccessUnverifiedContext.Provider value={unverified}>
        {children}
      </CloudInstanceAccessUnverifiedContext.Provider>
    </CloudInstanceAccessContext.Provider>
  );
}

/** The account was allowed but cannot be rechecked right now: pages stay, saving waits. */
export function useCloudInstanceAccessUnverified(): boolean {
  return useContext(CloudInstanceAccessUnverifiedContext);
}

export function useCloudInstanceAccess(): Access {
  return useContext(CloudInstanceAccessContext);
}
