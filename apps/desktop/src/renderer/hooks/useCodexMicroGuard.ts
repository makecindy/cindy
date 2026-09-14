import { useCallback, useEffect, useRef, useState } from 'react';

import type { CodexMicroGuardState } from '../../shared/codexMicroGuard';

export interface CodexMicroGuardViewState {
  state: CodexMicroGuardState | null;
  loading: boolean;
  saving: boolean;
  error: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  recover(): Promise<void>;
  reload(): Promise<void>;
}

export function useCodexMicroGuard(): CodexMicroGuardViewState {
  const [state, setState] = useState<CodexMicroGuardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const mutationRef = useRef(0);

  const reload = useCallback(async () => {
    const api = window.electronAPI?.codexMicroGuard;
    if (!api) {
      if (mountedRef.current) {
        setLoading(false);
        setError(true);
      }
      return;
    }
    if (mountedRef.current) {
      setLoading(true);
      setError(false);
    }
    try {
      const next = await api.getState();
      if (mountedRef.current) setState(next);
    } catch {
      if (mountedRef.current) setError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = window.electronAPI?.codexMicroGuard?.onStateChanged((next) => {
      if (!mountedRef.current) return;
      setState(next);
      setError(false);
    });
    void reload();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [reload]);

  const mutate = useCallback(
    async (operation: () => Promise<CodexMicroGuardState>) => {
      const request = ++mutationRef.current;
      if (mountedRef.current) {
        setSaving(true);
        setError(false);
      }
      try {
        const next = await operation();
        if (mountedRef.current && request === mutationRef.current) setState(next);
      } catch {
        if (mountedRef.current && request === mutationRef.current) {
          await reload();
          if (mountedRef.current && request === mutationRef.current) setError(true);
        }
      } finally {
        if (mountedRef.current && request === mutationRef.current) setSaving(false);
      }
    },
    [reload],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const api = window.electronAPI?.codexMicroGuard;
      if (!api) {
        if (mountedRef.current) setError(true);
        return;
      }
      await mutate(() => api.setEnabled(enabled));
    },
    [mutate],
  );

  const recover = useCallback(async () => {
    const api = window.electronAPI?.codexMicroGuard;
    if (!api) {
      if (mountedRef.current) setError(true);
      return;
    }
    await mutate(() => api.recover());
  }, [mutate]);

  return { state, loading, saving, error, setEnabled, recover, reload };
}
