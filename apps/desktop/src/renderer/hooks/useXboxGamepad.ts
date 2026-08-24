import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  XboxGamepadSettings,
  XboxGamepadSettingsPatch,
  XboxGamepadState,
} from '../../shared/xboxGamepad';

export function useXboxGamepad(options: { watchConnection?: boolean } = {}) {
  const { watchConnection = false } = options;
  const [state, setState] = useState<XboxGamepadState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    const api = window.electronAPI?.xboxGamepad;
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
    try {
      const next = await api.getState();
      if (!mountedRef.current) return;
      setState(next);
      setError(null);
    } catch {
      if (mountedRef.current) setError('load');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const api = window.electronAPI?.xboxGamepad;
    const unsubscribe = api?.onStateChanged((next) => {
      if (!mountedRef.current) return;
      setState(next);
      setLoading(false);
    });
    void reload();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [reload]);

  useEffect(() => {
    if (!watchConnection) return;
    const api = window.electronAPI?.xboxGamepad;
    if (!api) return;
    const timer = window.setInterval(() => {
      void api.probe();
    }, 2_000);
    void api.probe();
    return () => window.clearInterval(timer);
  }, [watchConnection]);

  const setSettings = useCallback(async (patch: XboxGamepadSettingsPatch) => {
    const api = window.electronAPI?.xboxGamepad;
    if (!api) return;
    setSaving(true);
    try {
      const next = await api.setSettings(patch);
      if (mountedRef.current) {
        setState(next);
        setError(null);
      }
    } catch {
      if (mountedRef.current) setError('save');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, []);

  const resetSettings = useCallback(async () => {
    const api = window.electronAPI?.xboxGamepad;
    if (!api) return;
    setSaving(true);
    try {
      const next = await api.resetSettings();
      if (mountedRef.current) {
        setState(next);
        setError(null);
      }
    } catch {
      if (mountedRef.current) setError('save');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, []);

  return { state, loading, saving, error, setSettings, resetSettings, reload };
}

export type { XboxGamepadSettings };
