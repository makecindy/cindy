import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  GamepadFamily,
  XboxGamepadSettings,
  XboxGamepadSettingsPatch,
  XboxGamepadState,
} from '../../shared/xboxGamepad';

export function useXboxGamepad(
  options: { family?: GamepadFamily; watchConnection?: boolean } = {},
) {
  const { family = 'xbox', watchConnection = false } = options;
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
      setState(next[family]);
      setError(null);
    } catch {
      if (mountedRef.current) setError('load');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [family]);

  useEffect(() => {
    mountedRef.current = true;
    const api = window.electronAPI?.xboxGamepad;
    const unsubscribe = api?.onStateChanged((next) => {
      if (!mountedRef.current) return;
      setState(next[family]);
      setLoading(false);
    });
    void reload();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [family, reload]);

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

  const setSettings = useCallback(
    async (patch: XboxGamepadSettingsPatch) => {
      const api = window.electronAPI?.xboxGamepad;
      if (!api) return;
      setSaving(true);
      try {
        const next = await api.setSettings(family, patch);
        if (mountedRef.current) {
          setState(next[family]);
          setError(null);
        }
      } catch {
        if (mountedRef.current) setError('save');
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [family],
  );

  const resetSettings = useCallback(async () => {
    const api = window.electronAPI?.xboxGamepad;
    if (!api) return;
    setSaving(true);
    try {
      const next = await api.resetSettings(family);
      if (mountedRef.current) {
        setState(next[family]);
        setError(null);
      }
    } catch {
      if (mountedRef.current) setError('save');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [family]);

  return { state, loading, saving, error, setSettings, resetSettings, reload };
}

export type { XboxGamepadSettings };
