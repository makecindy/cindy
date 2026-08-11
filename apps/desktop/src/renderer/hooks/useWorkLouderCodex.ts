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
  reload(): Promise<void>;
}

export function useWorkLouderCodex(): WorkLouderCodexViewState {
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

  return { state, loading, saving, error, setSettings, reload };
}
