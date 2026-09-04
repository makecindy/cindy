import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';

export type AppearanceBackgroundSettings = Pick<
  AppearanceSettings,
  'backgroundImage' | 'backgroundOverlay' | 'backgroundBlur'
>;

function initial(): AppearanceBackgroundSettings {
  const value = normalizeAppearanceSettings(
    window.electronAPI?.appearanceSettings?.getSync?.() ?? DEFAULT_APPEARANCE_SETTINGS,
  );
  return pick(value);
}

function pick(value: AppearanceSettings): AppearanceBackgroundSettings {
  return {
    backgroundImage: value.backgroundImage,
    backgroundOverlay: value.backgroundOverlay,
    backgroundBlur: value.backgroundBlur,
  };
}

export function useAppearanceBackground() {
  const [settings, setSettings] = useState<AppearanceBackgroundSettings>(initial);
  const settingsRef = useRef(settings);

  const applySettings = useCallback((next: AppearanceBackgroundSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge?.onChanged) return;
    return bridge.onChanged((value) => {
      applySettings(pick(normalizeAppearanceSettings(value)));
    });
  }, [applySettings]);

  const setPatch = useCallback(
    async (patch: Partial<AppearanceBackgroundSettings>) => {
      const previous = settingsRef.current;
      const optimistic = { ...previous, ...patch };
      applySettings(optimistic);
      const bridge = window.electronAPI?.appearanceSettings;
      if (!bridge) {
        applySettings(previous);
        return false;
      }
      try {
        const next = await bridge.setPatch(patch);
        if (settingsRef.current === optimistic) {
          applySettings(pick(normalizeAppearanceSettings(next)));
        }
        return true;
      } catch {
        // Only roll back if no newer local change or main-process broadcast won
        // the race while this request was pending.
        if (settingsRef.current === optimistic) applySettings(previous);
        return false;
      }
    },
    [applySettings],
  );

  const importBackground = useCallback(async () => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return { canceled: true } as const;
    const result = await bridge.importBackground();
    if (!result.canceled) applySettings(pick(result.settings));
    return result;
  }, [applySettings]);

  const removeBackground = useCallback(async () => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    const next = await bridge.removeBackground();
    applySettings(pick(next));
  }, [applySettings]);

  return { ...settings, setPatch, importBackground, removeBackground };
}
