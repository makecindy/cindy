import { useCallback, useEffect, useState } from 'react';

export interface SessionTitleSettingsState {
  dynamicTitleEnabled: boolean;
  isCustomized: boolean;
  defaultDynamicTitleEnabled: boolean;
  loading: boolean;
}

const INITIAL: SessionTitleSettingsState = {
  dynamicTitleEnabled: false,
  isCustomized: false,
  defaultDynamicTitleEnabled: false,
  loading: true,
};

function normalize(payload: SessionTitleSettingsPayload): SessionTitleSettingsState {
  return {
    dynamicTitleEnabled: payload.dynamicTitleEnabled === true,
    isCustomized: payload.isCustomized === true,
    defaultDynamicTitleEnabled: payload.defaultDynamicTitleEnabled === true,
    loading: false,
  };
}

export function useSessionTitleSettings(): {
  state: SessionTitleSettingsState;
  setDynamicTitleEnabled: (enabled: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [state, setState] = useState<SessionTitleSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getSessionTitleSettings()
      .then((payload) => {
        if (!cancelled) setState(normalize(payload));
      })
      .catch(() => {
        if (!cancelled) setState((current) => ({ ...current, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setDynamicTitleEnabled = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setSessionTitleSettings({
      dynamicTitleEnabled: enabled,
    });
    setState(normalize(payload));
  }, []);

  const reset = useCallback(async () => {
    const payload = await window.electronAPI.resetSessionTitleSettings();
    setState(normalize(payload));
  }, []);

  return { state, setDynamicTitleEnabled, reset };
}
