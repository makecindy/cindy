import { useCallback, useEffect, useState } from 'react';

const LEGACY_SESSION_NOTIFICATION_KEY = 'notifications.wecomGroupEnabled';

export function useWecomGroupNotificationSettings() {
  const [enabled, setEnabledState] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      localStorage.removeItem(LEGACY_SESSION_NOTIFICATION_KEY);
    } catch {
      // Legacy preference cleanup is best-effort.
    }
    void window.electronAPI.wecomGroupNotification
      .getState()
      .then((state) => {
        if (cancelled) return;
        setConfigured(state.configured);
        setEnabledState(state.enabled);
        setMaskedKey(state.maskedKey);
      })
      .catch(() => {
        if (!cancelled) {
          setConfigured(false);
          setEnabledState(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    setBusy(true);
    try {
      const state = await window.electronAPI.wecomGroupNotification.setEnabled(next);
      setConfigured(state.configured);
      setEnabledState(state.enabled);
      setMaskedKey(state.maskedKey);
    } finally {
      setBusy(false);
    }
  }, []);

  const saveAndTest = useCallback(async (webhookUrl: string, testMessage: string) => {
    setBusy(true);
    try {
      const state = await window.electronAPI.wecomGroupNotification.saveAndTest(
        webhookUrl,
        testMessage,
      );
      setConfigured(state.configured);
      setEnabledState(state.enabled);
      setMaskedKey(state.maskedKey);
    } finally {
      setBusy(false);
    }
  }, []);

  const test = useCallback(async (testMessage: string) => {
    setBusy(true);
    try {
      await window.electronAPI.wecomGroupNotification.test(testMessage);
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await window.electronAPI.wecomGroupNotification.clear();
      setConfigured(false);
      setEnabledState(false);
      setMaskedKey(undefined);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    enabled,
    setEnabled,
    configured,
    maskedKey,
    busy,
    saveAndTest,
    test,
    clear,
  };
}
