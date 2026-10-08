import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  clampAppearanceWallpaperVisibility,
  clampAppearanceWallpaperBlur,
  normalizeAppearanceSettings,
  type AppearanceSettings,
  type WallpaperId,
  type WallpaperMotion,
  normalizeCustomWallpaperUrl,
  isCustomWallpaperVideo,
  getWallpaperVisibility,
} from '@/../shared/appearanceSettings';

import { getBuiltinWallpaperBackground } from '@/lib/wallpaper';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { WallpaperVideo } from '@/components/layout/WallpaperVideo';

export interface WallpaperSettings {
  wallpaperId: WallpaperId;
  wallpaperOverlay: number;
  wallpaperVisibility?: number | null;
  wallpaperBlur?: number | null;
  wallpaperMotion: WallpaperMotion;
  customWallpaperUrl?: string;
}

interface WallpaperSettingsContextValue extends WallpaperSettings {
  playbackFailed: boolean;
  visibility: number;
  setWallpaper: (id: WallpaperId) => void;
  setVisibility: (value: number) => void;
  setBlur: (value: number) => void;
  previewBlur: (value: number | null) => void;
  setMotion: (value: WallpaperMotion) => void;
  resetWallpaper: () => void;
}

const WallpaperSettingsContext = createContext<WallpaperSettingsContextValue | undefined>(
  undefined,
);

function getBridge(): typeof window.electronAPI.appearanceSettings | null {
  return window.electronAPI?.appearanceSettings ?? null;
}

function getInitialWallpaperSettings(): WallpaperSettings {
  const settings = normalizeAppearanceSettings(
    getBridge()?.getSync?.() ?? DEFAULT_APPEARANCE_SETTINGS,
  );
  return pickWallpaperSettings(settings);
}

function pickWallpaperSettings(settings: AppearanceSettings): WallpaperSettings {
  return {
    wallpaperId: settings.wallpaperId,
    wallpaperOverlay: settings.wallpaperOverlay,
    wallpaperVisibility: settings.wallpaperVisibility,
    wallpaperBlur: settings.wallpaperBlur,
    wallpaperMotion: settings.wallpaperMotion,
    customWallpaperUrl: settings.customWallpaperUrl,
  };
}

export function WallpaperSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<WallpaperSettings>(getInitialWallpaperSettings);
  const [blurPreview, setBlurPreview] = useState<number | null>(null);
  const [failedUrl, setFailedUrl] = useState('');
  const onPlaybackFailure = useCallback(
    () => setFailedUrl(settings.customWallpaperUrl ?? ''),
    [settings.customWallpaperUrl],
  );
  const onPlaybackReady = useCallback(() => setFailedUrl(''), []);
  const isDark = useIsDarkMode();
  const visibility = getWallpaperVisibility(settings, isDark);
  // Document-level surface also covers settings, split panes, portals and detached
  // app windows, without changing the layout tree or stacking order of its panes.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const customUrl = normalizeCustomWallpaperUrl(settings.customWallpaperUrl);
    const background =
      settings.wallpaperId === 'custom'
        ? customUrl
          ? isCustomWallpaperVideo(customUrl)
            ? 'none'
            : `url("${customUrl}")`
          : undefined
        : getBuiltinWallpaperBackground(settings.wallpaperId);
    const active = Boolean(background);
    if (active) {
      root.dataset.wallpaperActive = 'true';
      root.style.setProperty('--app-wallpaper-image', background!);
      // One cover-fitted canvas; theme-derived veil keeps messages readable.
      const veil = 100 - visibility * 100;
      root.style.setProperty('--app-wallpaper-veil', `${veil}%`);
      const blur = blurPreview ?? settings.wallpaperBlur ?? 0;
      if (blur > 0 && visibility > 0) {
        root.dataset.wallpaperBlur = 'true';
        root.style.setProperty('--app-wallpaper-blur', `${blur}px`);
      }
    }
    return () => {
      delete root.dataset.wallpaperActive;
      delete root.dataset.wallpaperBlur;
      for (const name of ['--app-wallpaper-image', '--app-wallpaper-veil', '--app-wallpaper-blur'])
        root.style.removeProperty(name);
    };
  }, [settings, visibility, blurPreview]);
  const settingsRef = useRef(settings);
  const confirmedRef = useRef(settings);
  const pendingRef = useRef<Array<{ id: number; patch: Partial<WallpaperSettings> }>>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const requestIdRef = useRef(0);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onChanged) return;
    let disposed = false;
    let revision = 0;
    const apply = (next: AppearanceSettings) => {
      const confirmed = pickWallpaperSettings(normalizeAppearanceSettings(next));
      confirmedRef.current = confirmed;
      const optimistic = pendingRef.current.reduce(
        (current, pending) => ({ ...current, ...pending.patch }),
        confirmed,
      );
      settingsRef.current = optimistic;
      setSettings(optimistic);
    };
    const unsubscribe = bridge.onChanged((next) => {
      revision++;
      apply(next);
    });
    const refresh = () => {
      const request = ++revision;
      void bridge
        .get?.()
        .then((state) => {
          if (
            !disposed &&
            revision === request &&
            state &&
            typeof state === 'object' &&
            'value' in state
          ) {
            apply(normalizeAppearanceSettings(state.value));
          }
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const patch = useCallback((next: Partial<WallpaperSettings>) => {
    const merged = { ...settingsRef.current, ...next };
    settingsRef.current = merged;
    setSettings(merged);
    const bridge = getBridge();
    if (!bridge) return;

    const id = ++requestIdRef.current;
    pendingRef.current.push({ id, patch: next });
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await bridge.setPatch(next);
          pendingRef.current = pendingRef.current.filter((pending) => pending.id !== id);
        } catch {
          pendingRef.current = pendingRef.current.filter((pending) => pending.id !== id);
          const optimistic = pendingRef.current.reduce(
            (current, pending) => ({ ...current, ...pending.patch }),
            confirmedRef.current,
          );
          settingsRef.current = optimistic;
          setSettings(optimistic);
        }
      });
  }, []);

  const setWallpaper = useCallback((wallpaperId: WallpaperId) => patch({ wallpaperId }), [patch]);
  const setVisibility = useCallback(
    (value: number) => patch({ wallpaperVisibility: clampAppearanceWallpaperVisibility(value) }),
    [patch],
  );
  const setMotion = useCallback(
    (value: WallpaperMotion) => patch({ wallpaperMotion: value }),
    [patch],
  );
  const setBlur = useCallback(
    (value: number) => {
      setBlurPreview(null);
      patch({ wallpaperBlur: clampAppearanceWallpaperBlur(value) });
    },
    [patch],
  );
  const previewBlur = useCallback((value: number | null) => {
    const blur = value === null ? null : clampAppearanceWallpaperBlur(value);
    // Radix keyboard input commits before its change callback. Do not recreate
    // a preview for the value already queued for saving (or the unchanged value).
    setBlurPreview(
      settingsRef.current.wallpaperId === 'none' ||
        blur === (settingsRef.current.wallpaperBlur ?? 0)
        ? null
        : blur,
    );
  }, []);
  const resetWallpaper = useCallback(() => {
    setBlurPreview(null);
    patch({
      wallpaperId: DEFAULT_APPEARANCE_SETTINGS.wallpaperId,
      wallpaperOverlay: DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay,
      wallpaperVisibility: null,
      wallpaperBlur: null,
      wallpaperMotion: DEFAULT_APPEARANCE_SETTINGS.wallpaperMotion,
    });
  }, [patch]);

  const value = useMemo<WallpaperSettingsContextValue>(
    () => ({
      ...settings,
      wallpaperBlur: blurPreview ?? settings.wallpaperBlur,
      visibility,
      playbackFailed: !!failedUrl && failedUrl === settings.customWallpaperUrl,
      setWallpaper,
      setVisibility,
      setBlur,
      previewBlur,
      setMotion,
      resetWallpaper,
    }),
    [
      resetWallpaper,
      setMotion,
      setVisibility,
      setBlur,
      previewBlur,
      blurPreview,
      setWallpaper,
      settings,
      failedUrl,
      visibility,
    ],
  );

  return (
    <WallpaperSettingsContext.Provider value={value}>
      {visibility > 0 && (
        <WallpaperVideo
          wallpaperId={settings.wallpaperId}
          motion={settings.wallpaperMotion}
          customWallpaperUrl={settings.customWallpaperUrl}
          onFailure={onPlaybackFailure}
          onReady={onPlaybackReady}
        />
      )}
      {children}
    </WallpaperSettingsContext.Provider>
  );
}

export function useWallpaperSettings(): WallpaperSettingsContextValue {
  const context = useContext(WallpaperSettingsContext);
  if (!context)
    throw new Error('useWallpaperSettings must be used within WallpaperSettingsProvider');
  return context;
}
