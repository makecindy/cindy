import { useCallback, useEffect, useRef, useState } from 'react';
import type { WallpaperId } from '@/../shared/appearanceSettings';
import { isCdnWallpaper } from '@/lib/wallpaper';
import manifest from '@/../shared/wallpaper-video-manifest.json';

type AssetState = {
  key: string;
  url: string | null;
  status: 'loading' | 'ready' | 'failed';
  loaded: number;
};

/** Only selected media is requested. Main owns durable caching and cross-window deduplication. */
export function useWallpaperAsset(id: WallpaperId, kind: 'image' | 'video', enabled: boolean) {
  const key = `${id}:${kind}`;
  const [state, setState] = useState<AssetState | null>(null);
  // Keep resolved URLs across selections. Only decoded images enter this cache;
  // main remains responsible for durable files and validation on first use.
  const readyUrls = useRef(new Map<string, string>());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const entry = isCdnWallpaper(id) ? manifest[id] : null;
  const videoBytes = entry && 'bytes' in entry && typeof entry.bytes === 'number' ? entry.bytes : 0;
  const total = kind === 'image' ? (entry?.image.bytes ?? 0) : videoBytes;
  const active = enabled && total > 0;
  const url = readyUrls.current.get(key) ?? (state?.key === key ? state.url : null);
  const failed = active && !url && state?.key === key && state.status === 'failed';
  const bridge = window.electronAPI?.appearanceSettings;
  const canEnsure = Boolean(
    kind === 'image' ? bridge?.ensureWallpaperImage : bridge?.ensureWallpaperVideo,
  );

  useEffect(() => {
    if (!active || url) return;
    const bridge = window.electronAPI?.appearanceSettings;
    const ensure = kind === 'image' ? bridge?.ensureWallpaperImage : bridge?.ensureWallpaperVideo;
    if (!ensure) return;
    let current = true;
    let running = false;
    let automaticRetries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = bridge?.onWallpaperDownloadProgress?.((progress) => {
      if (!current || !running || progress.wallpaperId !== id || progress.kind !== kind) return;
      if (!Number.isFinite(progress.loaded) || progress.total !== total) return;
      setState((previous) =>
        previous?.key === key && previous.status === 'loading'
          ? { ...previous, loaded: Math.max(0, Math.min(total, progress.loaded)) }
          : previous,
      );
    });
    const run = async () => {
      if (!current || running) return;
      running = true;
      clearTimeout(timer);
      setState({ key, url: null, status: 'loading', loaded: 0 });
      let downloaded: string | null = null;
      try {
        downloaded = await ensure(id);
        if (downloaded && kind === 'image') {
          const image = new Image();
          image.src = downloaded;
          await image.decode();
        }
      } catch {
        downloaded = null;
      }
      running = false;
      if (!current) return;
      if (downloaded) readyUrls.current.set(key, downloaded);
      setState((previous) => ({
        key,
        url: downloaded,
        status: downloaded ? 'ready' : 'failed',
        loaded: downloaded ? total : previous?.key === key ? previous.loaded : 0,
      }));
      if (!downloaded && automaticRetries < 2) timer = setTimeout(retryAutomatically, 30_000);
    };
    const retryAutomatically = () => {
      if (!current || running || automaticRetries >= 2) return;
      automaticRetries++;
      void run();
    };
    window.addEventListener('online', retryAutomatically);
    void run();
    return () => {
      current = false;
      clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('online', retryAutomatically);
      // Small transfers can finish into the shared cache; never cancel another window's request.
    };
  }, [active, id, key, kind, attempt, url, total]);

  return {
    url,
    // Report pending on the selection's first render, before the effect starts,
    // so the canvas cannot flash its thumbnail for a frame.
    loading: active && !url && !failed && canEnsure,
    failed,
    loaded: active ? (url ? total : state?.key === key ? state.loaded : 0) : 0,
    total: active ? total : 0,
    retry,
  };
}
