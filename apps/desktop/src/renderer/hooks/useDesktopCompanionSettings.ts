import { useCallback, useEffect, useState } from 'react';
import type { DesktopCompanionSnapshot } from '../../shared/desktopCompanion';

const EMPTY: DesktopCompanionSnapshot = {
  supported: false, systemSupported: false, generation: -1,
  enabled: false, locationEnabled: false, systemEnabled: false,
  status: 'idle', lastTopic: null, lastUpdatedAt: null, lastError: null,
  previewSrc: null, imageReady: false, videoReady: false,
};

/** Keep account generations ordered; an old response must never restore its artwork. */
export function useDesktopCompanionSettings() {
  const [snapshot, setSnapshot] = useState<DesktopCompanionSnapshot>(EMPTY);
  const [legacyPreview, setLegacyPreview] = useState<{ generation: number; url: string } | null>(null);

  useEffect(() => {
    const bridge = window.electronAPI?.desktopCompanion;
    if (!bridge) {
      setSnapshot(EMPTY);
      return;
    }
    let disposed = false;
    let revision = 0;
    const apply = (next: DesktopCompanionSnapshot) => {
      if (!disposed) setSnapshot((current) => next.generation >= current.generation ? next : current);
    };
    const unsubscribe = bridge.onState((next) => { revision++; apply(next); });
    const request = revision;
    void bridge.getState().then((next) => {
      if (request === revision) apply(next);
    }).catch(() => {
      if (!disposed && request === revision)
        setSnapshot({ ...EMPTY, lastError: 'STATE_UNAVAILABLE' });
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    setLegacyPreview(null);
    if (!snapshot.enabled || snapshot.previewSrc !== 'legacy') return;
    let cancelled = false;
    void window.electronAPI.desktopCompanion.getPreview('legacy').then((url) => {
      if (!cancelled) setLegacyPreview({ generation: snapshot.generation, url });
    }).catch(() => {
      if (!cancelled) setSnapshot((current) => ({ ...current, lastError: 'PREVIEW_UNAVAILABLE' }));
    });
    return () => { cancelled = true; };
  }, [snapshot.enabled, snapshot.generation, snapshot.previewSrc]);

  const update = useCallback(async (action: () => Promise<DesktopCompanionSnapshot>) => {
    try {
      const next = await action();
      setSnapshot((current) => next.generation >= current.generation ? next : current);
    } catch {
      setSnapshot((current) => ({ ...current, lastError: 'SETTINGS_FAILED' }));
    }
  }, []);
  const setEnabled = useCallback((enabled: boolean) =>
    update(() => window.electronAPI.desktopCompanion.setEnabled(enabled)), [update]);
  const setLocationEnabled = useCallback((enabled: boolean) =>
    update(() => window.electronAPI.desktopCompanion.setLocationEnabled(enabled)), [update]);
  const setSystemEnabled = useCallback((enabled: boolean) =>
    update(() => window.electronAPI.desktopCompanion.setSystemEnabled(enabled)), [update]);
  const refresh = useCallback(() =>
    update(() => window.electronAPI.desktopCompanion.refresh()), [update]);
  const source = snapshot.enabled ? snapshot.previewSrc : null;
  const previewDataUrl = source && /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.webp$/.test(source)
    ? source
    : source === 'legacy' && legacyPreview?.generation === snapshot.generation ? legacyPreview.url : null;
  return { snapshot, previewDataUrl, setEnabled, setLocationEnabled, setSystemEnabled, refresh };
}
