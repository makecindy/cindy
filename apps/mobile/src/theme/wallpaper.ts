import { createContext, useContext } from 'react';
import type { ThemeMode } from './tokens';
import type { ImagePickerAsset } from 'expo-image-picker';

export function supportsAppWallpaper(platform: string) {
  return platform === 'ios';
}

// The focal point keeps the subject in view as a full-width landscape scene
// is cropped for a portrait phone viewport.
export const wallpaperSources = {
  'cindy-whisper': {
    focus: 0.67,
    image: () => require('../../assets/wallpapers/cindy-whisper.jpg'),
    video: () => require('../../assets/wallpapers/cindy-whisper.mp4'),
    tile: () => require('../../assets/wallpapers/cindy-whisper-tile.jpg'),
  },
  'cindy-night-glance': {
    focus: 0.32,
    image: () => require('../../assets/wallpapers/cindy-night-glance.jpg'),
    video: () => require('../../assets/wallpapers/cindy-night-glance.mp4'),
    tile: () => require('../../assets/wallpapers/cindy-night-glance-tile.jpg'),
  },
  'cindy-scarlet-stroll': {
    focus: 0.6,
    image: () => require('../../assets/wallpapers/cindy-scarlet-stroll.jpg'),
    video: () => require('../../assets/wallpapers/cindy-scarlet-stroll.mp4'),
    tile: () => require('../../assets/wallpapers/cindy-scarlet-stroll-tile.jpg'),
  },
  'cindy-neon': {
    focus: 0.52,
    image: () => require('../../assets/wallpapers/cindy-neon.jpg'),
    video: () => require('../../assets/wallpapers/cindy-neon.mp4'),
    tile: () => require('../../assets/wallpapers/cindy-neon-tile.jpg'),
  },
  'cindy-prism': {
    focus: 0.59,
    image: () => require('../../assets/wallpapers/cindy-prism.jpg'),
    video: () => require('../../assets/wallpapers/cindy-prism.mp4'),
    tile: () => require('../../assets/wallpapers/cindy-prism-tile.jpg'),
  },
};

export type SceneId = keyof typeof wallpaperSources;
export type WallpaperId = 'none' | 'custom' | SceneId;
export type CustomWallpaperFile = {
  id: string; width: number; height: number; video: 'mp4' | 'mov' | 'm4v' | null;
};
export type CustomWallpaper = CustomWallpaperFile & { imageUri: string; videoUri: string | null };
export type WallpaperChoice = { selected: WallpaperId; dynamic: boolean; custom: CustomWallpaper | null };
export const defaultWallpaper: WallpaperChoice = { selected: 'none', dynamic: false, custom: null };
export const WallpaperContext = createContext({
  ...defaultWallpaper,
  select: async (_id: WallpaperId, _dynamic?: boolean): Promise<void> => undefined,
  importCustom: async (_asset: ImagePickerAsset): Promise<void> => undefined,
  removeCustom: async (): Promise<void> => undefined,
});
export const useWallpaper = () => useContext(WallpaperContext);

// Desktop's in-page surfaces tint the canvas at 72% in Light and 64% in Dark.
// Only the fill is translucent. The mobile surface tokens are six-digit hex.
export function wallpaperRaisedFill(surface: string, mode: ThemeMode) {
  return surface + (mode === 'dark' ? 'A3' : 'B8');
}
