import type { WallpaperId } from '@/../shared/appearanceSettings';
import wallpaperManifest from '@/../shared/wallpaper-video-manifest.json';
import cindyWindow from '@/assets/wallpapers/previews/cindy-window.webp';
import cindyStudio from '@/assets/wallpapers/previews/cindy-studio.webp';
import cindyDream from '@/assets/wallpapers/previews/cindy-dream.webp';
import cindyWhisper from '@/assets/wallpapers/thumbnails/cindy-whisper.webp';
import cindyNeon from '@/assets/wallpapers/thumbnails/cindy-neon.webp';
import cindyPrism from '@/assets/wallpapers/thumbnails/cindy-prism.webp';
import cindyCrimson from '@/assets/wallpapers/thumbnails/cindy-crimson.webp';
import cindyNightGlance from '@/assets/wallpapers/thumbnails/cindy-night-glance.webp';
import cindyScarletStroll from '@/assets/wallpapers/thumbnails/cindy-scarlet-stroll.webp';
import cloudRoaming from '@/assets/wallpapers/thumbnails/cloud-roaming.webp';
import nightLaunch from '@/assets/wallpapers/thumbnails/night-launch.webp';
import stardustVortex from '@/assets/wallpapers/thumbnails/stardust-vortex.webp';
import silentOrbits from '@/assets/wallpapers/thumbnails/silent-orbits.webp';
import duneDawn from '@/assets/wallpapers/thumbnails/dune-dawn.webp';
import planetDawn from '@/assets/wallpapers/thumbnails/planet-dawn.webp';
import neonValley from '@/assets/wallpapers/thumbnails/neon-valley.webp';
import silentCircuit from '@/assets/wallpapers/thumbnails/silent-circuit.webp';
import indigoFolds from '@/assets/wallpapers/thumbnails/indigo-folds.webp';
import wheatfieldWatch from '@/assets/wallpapers/thumbnails/wheatfield-watch.webp';
import moonSolitude from '@/assets/wallpapers/thumbnails/moon-solitude.webp';
import teacupCat from '@/assets/wallpapers/thumbnails/teacup-cat.webp';
import duneSphere from '@/assets/wallpapers/thumbnails/dune-sphere.webp';
import amberLight from '@/assets/wallpapers/thumbnails/amber-light.webp';
import oceanClouds from '@/assets/wallpapers/thumbnails/ocean-clouds.webp';
import blushLeaves from '@/assets/wallpapers/thumbnails/blush-leaves.webp';
import whiteWilderness from '@/assets/wallpapers/thumbnails/white-wilderness.webp';
import blueGaze from '@/assets/wallpapers/thumbnails/blue-gaze.webp';
import roseQuartz from '@/assets/wallpapers/thumbnails/rose-quartz.webp';
import silverVeins from '@/assets/wallpapers/thumbnails/silver-veins.webp';
import dawnArc from '@/assets/wallpapers/thumbnails/dawn-arc.webp';
import tidalLines from '@/assets/wallpapers/thumbnails/tidal-lines.webp';

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
  'cindy-crimson': `url("${cindyCrimson}")`,
  'cindy-night-glance': `url("${cindyNightGlance}")`,
  'cindy-scarlet-stroll': `url("${cindyScarletStroll}")`,
  'cloud-roaming': `url("${cloudRoaming}")`,
  'night-launch': `url("${nightLaunch}")`,
  'stardust-vortex': `url("${stardustVortex}")`,
  'silent-orbits': `url("${silentOrbits}")`,
  'dune-dawn': `url("${duneDawn}")`,
  'planet-dawn': `url("${planetDawn}")`,
  'neon-valley': `url("${neonValley}")`,
  'silent-circuit': `url("${silentCircuit}")`,
  'indigo-folds': `url("${indigoFolds}")`,
  'wheatfield-watch': `url("${wheatfieldWatch}")`,
  'moon-solitude': `url("${moonSolitude}")`,
  'teacup-cat': `url("${teacupCat}")`,
  'dune-sphere': `url("${duneSphere}")`,
  'amber-light': `url("${amberLight}")`,
  'ocean-clouds': `url("${oceanClouds}")`,
  'blush-leaves': `url("${blushLeaves}")`,
  'white-wilderness': `url("${whiteWilderness}")`,
  'blue-gaze': `url("${blueGaze}")`,
  'rose-quartz': `url("${roseQuartz}")`,
  'silver-veins': `url("${silverVeins}")`,
  'dawn-arc': `url("${dawnArc}")`,
  'tidal-lines': `url("${tidalLines}")`,
};

export function getBuiltinWallpaperBackground(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_BACKGROUNDS[id];
}

export function getBuiltinWallpaperPreview(id: WallpaperId): string | undefined {
  return getBuiltinWallpaperBackground(id);
}
