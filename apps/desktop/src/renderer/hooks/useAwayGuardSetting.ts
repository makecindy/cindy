import { useCallback, useEffect, useRef, useState } from 'react';

import type { AwayGuardDelaySeconds, AwayGuardState } from '../../shared/awayGuard';

/** macOS "Keep working while away" toggle; re-reads on focus to pick up Accessibility grants. */
export function useAwayGuardSetting() {
  const [state, setState] = useState<AwayGuardState | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const supported = window.electronAPI?.platform === 'darwin';

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await window.electronAPI.windowBehavior.getAwayGuardState();
      if (mounted.current && generation.current === current) setState(next);
    } catch {
      if (mounted.current && generation.current === current) setState(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (supported) {
      void refresh();
      window.addEventListener('focus', refresh);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('focus', refresh);
    };
  }, [supported, refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const current = ++generation.current;
      setBusy(true);
      setState((previous) => (previous ? { ...previous, enabled } : previous));
      try {
        const next = await window.electronAPI.windowBehavior.setAwayGuardEnabled(enabled);
        if (mounted.current && generation.current === current) setState(next);
      } catch {
        if (mounted.current && generation.current === current) void refresh();
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );

  const setDelay = useCallback(
    async (delaySeconds: AwayGuardDelaySeconds | null) => {
      const current = ++generation.current;
      setState((previous) => (previous ? { ...previous, delaySeconds } : previous));
      try {
        const next = await window.electronAPI.windowBehavior.setAwayGuardDelay(delaySeconds);
        if (mounted.current && generation.current === current) setState(next);
      } catch {
        if (mounted.current && generation.current === current) void refresh();
      }
    },
    [refresh],
  );

  const [preview, setPreview] = useState<'idle' | 'starting' | 'permission' | 'unavailable'>('idle');
  const startPreview = useCallback(async () => {
    setPreview('starting');
    try {
      const result = await window.electronAPI.windowBehavior.previewAwayGuard();
      if (!mounted.current) return;
      setPreview(result.ok ? 'starting' : result.reason);
      if (!result.ok) void refresh();
    } catch {
      if (mounted.current) setPreview('unavailable');
    }
  }, [refresh]);
  // The masks arrive a few seconds after the click; the hint goes back once they did.
  useEffect(() => {
    if (preview !== 'starting') return;
    const timer = setTimeout(() => setPreview('idle'), 6_000);
    return () => clearTimeout(timer);
  }, [preview]);

  return {
    available: supported && state?.available === true,
    state,
    busy,
    setEnabled,
    setDelay,
    preview,
    startPreview,
  };
}
