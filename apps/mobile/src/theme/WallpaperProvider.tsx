import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ImagePickerAsset } from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultWallpaper, WallpaperContext, wallpaperSources, type WallpaperChoice, type WallpaperId } from './wallpaper';

const key = 'cindy.mobile.wallpaper.v1';
const motionPrefix = 'dynamic:';

function selection(id: unknown, dynamic: boolean, custom: WallpaperChoice['custom']): WallpaperChoice {
  if (id === 'custom' && custom) return { selected: id, dynamic: !!custom.video && dynamic, custom };
  if (typeof id === 'string' && Object.hasOwn(wallpaperSources, id)) {
    return { selected: id as WallpaperId, dynamic, custom };
  }
  return { ...defaultWallpaper, custom };
}

async function readChoice(): Promise<WallpaperChoice> {
  const stored = await AsyncStorage.getItem(key);
  if (!stored) return defaultWallpaper;
  if (stored.startsWith('{')) {
    let data;
    try { data = JSON.parse(stored); } catch { return defaultWallpaper; }
    const { restoreCustomWallpaper } = await import('./customWallpaper');
    const custom = await restoreCustomWallpaper(data.custom);
    return selection(data.selected, data.dynamic === true, custom);
  }
  const dynamic = stored.startsWith(motionPrefix);
  return selection(dynamic ? stored.slice(motionPrefix.length) : stored, dynamic, null);
}

function writeChoice({ selected, dynamic, custom }: WallpaperChoice) {
  if (custom) {
    const { id, width, height, video } = custom;
    return AsyncStorage.setItem(key, JSON.stringify({ selected, dynamic, custom: { id, width, height, video } }));
  }
  // Keep the original built-in preference format when there's no imported media.
  return selected === 'none' ? AsyncStorage.removeItem(key) :
    AsyncStorage.setItem(key, dynamic ? motionPrefix + selected : selected);
}

export function WallpaperProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState(defaultWallpaper);
  const current = useRef(defaultWallpaper);
  const hydration = useRef<Promise<void> | null>(null);
  const writes = useRef(Promise.resolve());
  const hydrate = useCallback(() => {
    hydration.current ??= readChoice().then(saved => {
      current.current = saved;
      setChoice(saved);
    }).catch(error => {
      hydration.current = null;
      throw error;
    });
    return hydration.current;
  }, []);
  useEffect(() => { void hydrate().catch(() => undefined); }, [hydrate]);

  // Commit the choice and its file reference together. Retire the old copy only
  // after the new preference is durable, even when two operations overlap.
  const change = useCallback((update: (previous: WallpaperChoice) => WallpaperChoice | Promise<WallpaperChoice>) => {
    const result = writes.current.then(async () => {
      await hydrate();
      const previous = current.current;
      const next = await update(previous);
      if (next === previous) return;
      try { await writeChoice(next); }
      catch (error) {
        if (next.custom && next.custom.id !== previous.custom?.id) {
          const { discardCustomWallpaper } = await import('./customWallpaper');
          await discardCustomWallpaper(next.custom.id).catch(() => undefined);
        }
        throw error;
      }
      current.current = next;
      setChoice(next);
      if (previous.custom && previous.custom.id !== next.custom?.id) {
        const { discardCustomWallpaper } = await import('./customWallpaper');
        await discardCustomWallpaper(previous.custom.id).catch(() => undefined);
      }
    });
    writes.current = result.catch(() => undefined);
    return result;
  }, [hydrate]);
  const select = useCallback((id: WallpaperId, motion?: boolean) => change(previous =>
    selection(id, motion ?? previous.dynamic, previous.custom)), [change]);
  const importCustom = useCallback((asset: ImagePickerAsset) => change(async previous => {
    const { cleanUnusedCustomWallpapers, prepareCustomWallpaper } = await import('./customWallpaper');
    await cleanUnusedCustomWallpapers(previous.custom?.id).catch(() => undefined);
    const custom = await prepareCustomWallpaper(asset);
    return selection('custom', !!custom.video, custom);
  }), [change]);
  const removeCustom = useCallback(() => change(previous => previous.custom
    ? selection(previous.selected, previous.dynamic, null) : previous), [change]);
  const value = useMemo(() => ({ ...choice, select, importCustom, removeCustom }), [choice, select, importCustom, removeCustom]);
  return <WallpaperContext.Provider value={value}>{children}</WallpaperContext.Provider>;
}
