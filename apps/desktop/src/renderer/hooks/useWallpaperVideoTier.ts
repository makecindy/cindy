import { useEffect, useState } from 'react';

export type WallpaperVideoTier = 'standard' | 'hd';

/** Cover-fit demand, expressed as the required width of a 16:10 source. */
export function chooseWallpaperVideoTier(
  width: number,
  height: number,
  pixelRatio: number,
  previous: WallpaperVideoTier = 'standard',
): WallpaperVideoTier {
  const demand = Math.max(width, height * 1.6) * pixelRatio;
  // Hysteresis prevents repeated decoder reloads near the size boundary.
  return demand > (previous === 'hd' ? 1680 : 1920) ? 'hd' : 'standard';
}

function readTier(previous?: WallpaperVideoTier): WallpaperVideoTier {
  return chooseWallpaperVideoTier(
    window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, previous,
  );
}

export function useWallpaperVideoTier(): WallpaperVideoTier {
  const [tier, setTier] = useState(() => readTier());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let query: MediaQueryList | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTier(previous => readTier(previous)), 350);
    };
    const watchPixelRatio = () => {
      query?.removeEventListener('change', onPixelRatioChange);
      query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query?.addEventListener('change', onPixelRatioChange);
    };
    const onPixelRatioChange = () => {
      watchPixelRatio();
      update();
    };
    watchPixelRatio();
    window.addEventListener('resize', update);
    update();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', update);
      query?.removeEventListener('change', onPixelRatioChange);
    };
  }, []);
  return tier;
}
