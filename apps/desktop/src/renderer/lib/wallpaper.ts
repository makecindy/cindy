import type { WallpaperId } from '@/../shared/appearanceSettings';
import wallpaperManifest from '@/../shared/wallpaper-video-manifest.json';
import cindyWindow from '@/assets/wallpapers/previews/cindy-window.webp';
import cindyStudio from '@/assets/wallpapers/previews/cindy-studio.webp';
import cindyDream from '@/assets/wallpapers/previews/cindy-dream.webp';
import cindyWhisper from '@/assets/wallpapers/thumbnails/cindy-whisper.webp';
import cindyNeon from '@/assets/wallpapers/thumbnails/cindy-neon.webp';
import cindyPrism from '@/assets/wallpapers/thumbnails/cindy-prism.webp';
import cindyNightGlance from '@/assets/wallpapers/thumbnails/cindy-night-glance.webp';
import cindyScarletStroll from '@/assets/wallpapers/thumbnails/cindy-scarlet-stroll.webp';
import nightLaunch from '@/assets/wallpapers/thumbnails/night-launch.webp';
import silentOrbits from '@/assets/wallpapers/thumbnails/silent-orbits.webp';
import duneDawn from '@/assets/wallpapers/thumbnails/dune-dawn.webp';
import planetDawn from '@/assets/wallpapers/thumbnails/planet-dawn.webp';
import indigoFolds from '@/assets/wallpapers/thumbnails/indigo-folds.webp';
import duneSphere from '@/assets/wallpapers/thumbnails/dune-sphere.webp';
import oceanClouds from '@/assets/wallpapers/thumbnails/ocean-clouds.webp';
import roseQuartz from '@/assets/wallpapers/thumbnails/rose-quartz.webp';

/** All official originals use the main-process downloader; only previews are bundled. */
export function isCdnWallpaper(id: WallpaperId): id is keyof typeof wallpaperManifest {
  return (
    Object.hasOwn(wallpaperManifest, id) &&
    wallpaperManifest[id as keyof typeof wallpaperManifest].delivery === 'cdn'
  );
}

export function isSceneWallpaper(id: WallpaperId): boolean {
  return (
    Object.hasOwn(wallpaperManifest, id) &&
    'sha256' in wallpaperManifest[id as keyof typeof wallpaperManifest]
  );
}

/** Decorative artwork; the application applies a theme-derived readability veil. */
const BUILTIN_WALLPAPER_BACKGROUNDS: Partial<Record<WallpaperId, string>> = {
  'cindy-window': `url("${cindyWindow}")`,
  'cindy-studio': `url("${cindyStudio}")`,
  'cindy-dream': `url("${cindyDream}")`,
  'cindy-whisper': `url("${cindyWhisper}")`,
  'cindy-neon': `url("${cindyNeon}")`,
  'cindy-prism': `url("${cindyPrism}")`,
  'cindy-night-glance': `url("${cindyNightGlance}")`,
  'cindy-scarlet-stroll': `url("${cindyScarletStroll}")`,
  'night-launch': `url("${nightLaunch}")`,
  'silent-orbits': `url("${silentOrbits}")`,
  'dune-dawn': `url("${duneDawn}")`,
  'planet-dawn': `url("${planetDawn}")`,
  'indigo-folds': `url("${indigoFolds}")`,
  'dune-sphere': `url("${duneSphere}")`,
  'ocean-clouds': `url("${oceanClouds}")`,
  'rose-quartz': `url("${roseQuartz}")`,
};

export function getBuiltinWallpaperBackground(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_BACKGROUNDS[id];
}

export function getBuiltinWallpaperPreview(id: WallpaperId): string | undefined {
  return getBuiltinWallpaperBackground(id);
}
