import { useCallback, useEffect, useState } from 'react';

import type { DesktopCompanionSnapshot } from '../../shared/desktopCompanion';

const EMPTY: DesktopCompanionSnapshot = {
  supported: false,
  enabled: false,
  locationEnabled: false,
  status: 'idle',
  lastTopic: null,
  lastUpdatedAt: null,
  lastError: null,
  previewSrc: null,
  imageReady: false,
  videoReady: false,
};

export function useDesktopCompanionSettings(): {
  snapshot: DesktopCompanionSnapshot;
  previewDataUrl: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  setLocationEnabled: (enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<DesktopCompanionSnapshot>(EMPTY);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.desktopCompanion.getState().then((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const unsubscribe = window.electronAPI.desktopCompanion.onState((next) => setSnapshot(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setSnapshot(await window.electronAPI.desktopCompanion.setEnabled(enabled));
  }, []);

  useEffect(() => {
    const filePath = snapshot.previewSrc;
    if (!filePath) {
      setPreviewDataUrl(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI.desktopCompanion
      .getPreview(filePath)
      .then((dataUrl) => {
        if (!cancelled) setPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.previewSrc]);

  const setLocationEnabled = useCallback(async (enabled: boolean) => {
    setSnapshot(await window.electronAPI.desktopCompanion.setLocationEnabled(enabled));
  }, []);

  const refresh = useCallback(async () => {
    setSnapshot(await window.electronAPI.desktopCompanion.refresh());
  }, []);

  return { snapshot, previewDataUrl, setEnabled, setLocationEnabled, refresh };
}
