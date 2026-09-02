import { useCallback, useEffect, useState } from 'react';

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

  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge?.onChanged) return;
    return bridge.onChanged((value) => {
      setSettings(pick(normalizeAppearanceSettings(value)));
    });
  }, []);

  const setPatch = useCallback(async (patch: Partial<AppearanceBackgroundSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    const next = await bridge.setPatch(patch);
    setSettings(pick(normalizeAppearanceSettings(next)));
  }, []);

  const importBackground = useCallback(async () => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return { canceled: true } as const;
    const result = await bridge.importBackground();
    if (!result.canceled) setSettings(pick(result.settings));
    return result;
  }, []);

  const removeBackground = useCallback(async () => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    const next = await bridge.removeBackground();
    setSettings(pick(next));
  }, []);

  return { ...settings, setPatch, importBackground, removeBackground };
}
