import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  WorkLouderCodexSettings,
  WorkLouderCodexSettingsPatch,
  WorkLouderCodexState,
} from '../../shared/workLouderCodex';

export interface WorkLouderCodexViewState {
  state: WorkLouderCodexState | null;
  loading: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
  setSettings(patch: WorkLouderCodexSettingsPatch): Promise<void>;
  resetSettings(): Promise<void>;
  openInputMonitoringSettings(): Promise<void>;
  reload(): Promise<void>;
}

export interface WorkLouderCodexOptions {
  /**
   * Poll the device while this view is on screen.
   *
   * The Work Louder SDK has no disconnect event, so an unplugged keyboard keeps
   * reading as connected until something tries to talk to it. Anywhere that
   * shows connection state has to ask. Only the settings page opts in: polling
   * wakes the device, which costs battery over Bluetooth, and nowhere else is
   * showing a status the user is watching.
   */
  watchConnection?: boolean;
}

/** How often the settings page re-checks the device while it is in view. */
const CONNECTION_PROBE_MS = 2_000;

export function useWorkLouderCodex(options: WorkLouderCodexOptions = {}): WorkLouderCodexViewState {
  const { watchConnection = false } = options;
  const [state, setState] = useState<WorkLouderCodexState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const mountedRef = useRef(true);
  const mutationIdRef = useRef(0);
  const pushVersionRef = useRef(0);
  const confirmedSettingsRef = useRef<WorkLouderCodexSettings | null>(null);

  const reload = useCallback(async () => {
    const api = window.electronAPI?.workLouderCodex;
    if (!api) {
      if (mountedRef.current) {
        setLoading(false);
        setError('load');
      }
      return;
    }
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    const pushVersion = pushVersionRef.current;
    try {
      const next = await api.getState();
      if (!mountedRef.current) return;
      if (pushVersion === pushVersionRef.current) {
        confirmedSettingsRef.current = { ...next.settings };
        setState(next);
      }
      setError(null);
    } catch {
      if (mountedRef.current) setError('load');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const api = window.electronAPI?.workLouderCodex;
    const unsubscribe = api?.onStateChanged((next) => {
      if (!mountedRef.current) return;
      pushVersionRef.current += 1;
      confirmedSettingsRef.current = { ...next.settings };
      setState(next);
    });
    void reload();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [reload]);

  /**
   * Poll for an unplug while the caller is showing connection state.
   *
   * Pauses whenever the window is hidden or in the background: an unattended
   * app has no reason to keep waking the keyboard, and whoever comes back gets
   * a fresh reading immediately because visibility change probes right away.
   */
  useEffect(() => {
    if (!watchConnection) return;
    const api = window.electronAPI?.workLouderCodex;
    if (!api?.probe) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const probe = (): void => {
      void api.probe().catch(() => {
        // A failed probe is itself inconclusive; the next one decides.
      });
    };
    const start = (): void => {
      if (timer) return;
      probe();
      timer = setInterval(probe, CONNECTION_PROBE_MS);
    };
    const stop = (): void => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const sync = (): void => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stop();
    };
  }, [watchConnection]);

  const setSettings = useCallback(
    async (patch: WorkLouderCodexSettingsPatch) => {
      const api = window.electronAPI?.workLouderCodex;
      if (!api) {
        if (mountedRef.current) setError('save');
        return;
      }
      const requestId = ++mutationIdRef.current;
      const previous = state;
      if (mountedRef.current) {
        setSaving(true);
        setError(null);
        setState((current) =>
          current ? { ...current, settings: { ...current.settings, ...patch } } : current,
        );
      }
      try {
        const next = await api.setSettings(patch);
        if (!mountedRef.current || requestId !== mutationIdRef.current) return;
        confirmedSettingsRef.current = { ...next.settings };
        setState(next);
      } catch {
        if (!mountedRef.current || requestId !== mutationIdRef.current) return;
        const rollbackSettings = confirmedSettingsRef.current ?? previous?.settings;
        if (rollbackSettings) {
          setState((current) =>
            current
              ? { ...current, settings: { ...rollbackSettings } }
              : previous
                ? { ...previous, settings: { ...rollbackSettings } }
                : current,
          );
        }
        setError('save');
      } finally {
        if (mountedRef.current && requestId === mutationIdRef.current) setSaving(false);
      }
    },
    [state],
  );

  const resetSettings = useCallback(async () => {
    const api = window.electronAPI?.workLouderCodex;
    if (!api) {
      if (mountedRef.current) setError('save');
      return;
    }
    const requestId = ++mutationIdRef.current;
    if (mountedRef.current) {
      setSaving(true);
      setError(null);
    }
    try {
      const next = await api.resetSettings();
      if (!mountedRef.current || requestId !== mutationIdRef.current) return;
      confirmedSettingsRef.current = { ...next.settings };
      setState(next);
    } catch {
      if (mountedRef.current && requestId === mutationIdRef.current) setError('save');
    } finally {
      if (mountedRef.current && requestId === mutationIdRef.current) setSaving(false);
    }
  }, []);

  const openInputMonitoringSettings = useCallback(async () => {
    try {
      await window.electronAPI?.workLouderCodex?.openInputMonitoringSettings();
    } catch {
      if (mountedRef.current) setError('load');
    }
  }, []);

  return {
    state,
    loading,
    saving,
    error,
    setSettings,
    resetSettings,
    openInputMonitoringSettings,
    reload,
  };
}
