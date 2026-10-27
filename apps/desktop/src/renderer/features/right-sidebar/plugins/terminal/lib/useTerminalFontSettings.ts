import { useEffect, useState } from 'react';

import {
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';

export type TerminalFontSettings = Pick<AppearanceSettings, 'terminalFamily' | 'terminalSize'>;

function readTerminalFonts(raw: unknown): TerminalFontSettings {
  const { terminalFamily, terminalSize } = normalizeAppearanceSettings(raw);
  return { terminalFamily, terminalSize };
}

/** Read-only in both sidebar hosts; the detached window needs no settings Provider. */
export function useTerminalFontSettings(): TerminalFontSettings {
  const [settings, setSettings] = useState(() =>
    readTerminalFonts(window.electronAPI?.appearanceSettings?.getSync?.()),
  );

  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    const receive = (raw: unknown) => {
      const next = readTerminalFonts(raw);
      setSettings((current) =>
        current.terminalFamily === next.terminalFamily && current.terminalSize === next.terminalSize
          ? current
          : next,
      );
    };
    const unsubscribe = bridge.onChanged(receive);
    // The preload cache also receives changes while this component is absent.
    // Subscribe before reading again to close the render-to-effect gap.
    receive(bridge.getSync());
    return unsubscribe;
  }, []);

  return settings;
}
