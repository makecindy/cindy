import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { mobileDebugLog } from './mobileDebugLog';

type RecoveryState = 'syncing' | 'recovered';

/** Measure only the time the user can see this page; keep total time separately. */
export function useContentRecoveryDiagnostics(state: RecoveryState, identity: string): void {
  const active = useRef(false);
  const pending = useRef<{
    identity: string;
    wallStartedAt: number;
    activeStartedAt: number | null;
    foregroundMs: number;
  } | null>(null);
  const setActive = useCallback((next: boolean) => {
    active.current = next;
    const current = pending.current;
    if (!current) return;
    const now = performance.now();
    if (current.activeStartedAt !== null) {
      current.foregroundMs += Math.max(0, now - current.activeStartedAt);
    }
    current.activeStartedAt = next ? now : null;
  }, []);

  useEffect(() => {
    if (pending.current?.identity !== identity) pending.current = null;
    if (state === 'syncing') {
      pending.current = {
        identity, wallStartedAt: Date.now(), foregroundMs: 0,
        activeStartedAt: active.current ? performance.now() : null,
      };
      mobileDebugLog('debug', 'recovery', 'content recovery state', {
        state, elapsedMs: 0, foregroundElapsedMs: 0, wallElapsedMs: 0,
      });
    } else if (pending.current) {
      setActive(active.current);
      const current = pending.current;
      mobileDebugLog('debug', 'recovery', 'content recovery state', {
        state,
        elapsedMs: current.foregroundMs,
        foregroundElapsedMs: current.foregroundMs,
        wallElapsedMs: Math.max(0, Date.now() - current.wallStartedAt),
      });
      pending.current = null;
    }
  }, [identity, setActive, state]);

  useFocusEffect(useCallback(() => {
    setActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', next => setActive(next === 'active'));
    return () => {
      setActive(false);
      subscription.remove();
    };
  }, [setActive]));
}
