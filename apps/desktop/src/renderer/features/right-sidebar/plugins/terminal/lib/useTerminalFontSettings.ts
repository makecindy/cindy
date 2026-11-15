import { useEffect, useState } from 'react';

import {
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';
import { isAppearanceFontReady, waitForAppearanceFont } from '@/appearance/AppearancePresenter';

export type TerminalFontSettings = Pick<AppearanceSettings, 'terminalFamily' | 'terminalSize'>;

function readTerminalFonts(raw: unknown): TerminalFontSettings {
  const { terminalFamily, terminalSize, terminalFontResource } = normalizeAppearanceSettings(raw);
  return { terminalFamily: terminalFontResource && !isAppearanceFontReady('terminalFont', terminalFamily) ? '' : terminalFamily, terminalSize };
}

/** Read-only in both sidebar hosts; the detached window needs no settings Provider. */
export function useTerminalFontSettings(): TerminalFontSettings {
  const [settings, setSettings] = useState(() =>
    readTerminalFonts(window.electronAPI?.appearanceSettings?.getSync?.()),
  );

  useEffect(() => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    let generation = 0;
    const receive = (raw: unknown) => {
      const request = ++generation;
      const next = readTerminalFonts(raw);
      setSettings((current) =>
        current.terminalFamily === next.terminalFamily && current.terminalSize === next.terminalSize
          ? current
          : next,
      );
      const latest = normalizeAppearanceSettings(raw);
      if (latest.terminalFontResource && !isAppearanceFontReady('terminalFont', latest.terminalFamily)) {
        void waitForAppearanceFont('terminalFont', latest.terminalFamily).then(ready => {
          if (ready && generation === request) setSettings({ terminalFamily: latest.terminalFamily, terminalSize: latest.terminalSize });
        });
      }
    };
    const unsubscribe = bridge.onChanged(receive);
    // The preload cache also receives changes while this component is absent.
    // Subscribe before reading again to close the render-to-effect gap.
    receive(bridge.getSync());
    return () => { generation++; unsubscribe(); };
  }, []);

  return settings;
}
