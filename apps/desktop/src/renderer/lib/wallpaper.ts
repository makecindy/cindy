import type { WallpaperId } from '@/../shared/appearanceSettings';
import videoManifest from '@/../shared/wallpaper-video-manifest.json';
import cindyWindow from '@/assets/wallpapers/cindy-window.webp';
import cindyStudio from '@/assets/wallpapers/cindy-studio.webp';
import cindyDream from '@/assets/wallpapers/cindy-dream.webp';
import cindyWindowVideo from '@/assets/wallpapers/cindy-window.mp4';
import cindyStudioVideo from '@/assets/wallpapers/cindy-studio.mp4';
import cindyDreamVideo from '@/assets/wallpapers/cindy-dream.mp4';

const SCENE_VIDEOS: Partial<Record<WallpaperId, string>> = {
  'cindy-window': cindyWindowVideo,
  'cindy-studio': cindyStudioVideo,
  'cindy-dream': cindyDreamVideo,
};

export function getWallpaperVideo(id: WallpaperId): string | undefined {
  return SCENE_VIDEOS[id];
}

/** Official scenes are fully offline; CDN delivery is opt-in for future catalog entries. */
export function usesCdnWallpaperVideo(id: WallpaperId): boolean {
  return Object.hasOwn(videoManifest, id) &&
    videoManifest[id as keyof typeof videoManifest].delivery === 'cdn';
}

export function isSceneWallpaper(id: WallpaperId): boolean {
  return id === 'cindy-window' || id === 'cindy-studio' || id === 'cindy-dream';
}

/** Decorative artwork; the application applies a theme-derived readability veil. */
const BUILTIN_WALLPAPER_BACKGROUNDS: Partial<Record<WallpaperId, string>> = {
  'cindy-window': `url("${cindyWindow}")`,
  'cindy-studio': `url("${cindyStudio}")`,
  'cindy-dream': `url("${cindyDream}")`,
};

export function getBuiltinWallpaperBackground(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_BACKGROUNDS[id];
}
