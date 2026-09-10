import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** One probe per foreground transition; no polling or automatic retry loop. */
export function useComposerWebViewRecovery(inject: (script: string) => void, invalidate: () => void, isReady: () => boolean) {
  const [generation, setGeneration] = useState(0);
  const current = useRef(0);
  const attempted = useRef(false);
  const terminated = useRef(false);
  const probe = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({ inject, invalidate, isReady });
  callbacks.current = { inject, invalidate, isReady };
  const cancelProbe = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    probe.current += 1;
  }, []);
  const recover = useCallback((reason: string) => {
    cancelProbe();
    if (attempted.current || AppState.currentState !== 'active') return;
    attempted.current = true;
    terminated.current = false;
    callbacks.current.invalidate();
    current.current += 1;
    setGeneration(current.current);
    mobileDebugLog('warn', 'recovery', 'composer rebuilding', { reason });
  }, [cancelProbe]);
  const onTerminated = useCallback(() => {
    if (generation !== current.current) return;
    terminated.current = true;
    current.current += 1; // Reject callbacks even while waiting in the background.
    callbacks.current.invalidate();
    recover('content-process-terminated');
  }, [generation, recover]);
  const onPong = useCallback((id: number) => {
    if (id === probe.current) cancelProbe();
  }, [cancelProbe]);
  const onReady = useCallback(() => {
    cancelProbe();
    if (attempted.current) mobileDebugLog('info', 'recovery', 'composer ready after rebuild');
  }, [cancelProbe]);
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      if (state === previous) return;
      const wasActive = previous === 'active';
      previous = state;
      cancelProbe();
      if (state !== 'active' || wasActive) return;
      attempted.current = false;
      if (terminated.current) {
        recover('foreground-after-termination');
        return;
      }
      // Initial loading and replacement loading are not evidence of a stalled editor.
      // Explicit process termination above must still recover before the first ready.
      if (!callbacks.current.isReady()) return;
      const id = probe.current;
      timer.current = setTimeout(() => recover('foreground-probe-timeout'), 3000);
      callbacks.current.inject(`window.cindyComposer.ping(${id});`);
    });
    return () => { subscription.remove(); cancelProbe(); };
  }, [cancelProbe, recover]);
  return { generation, current, onTerminated, onPong, onReady };
}
