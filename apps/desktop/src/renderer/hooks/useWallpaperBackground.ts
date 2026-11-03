import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One document canvas, including the fixed copies behind the composer. */
export function useWallpaperBackground({
  background,
  pending,
  visibility,
  blur,
  reducedMotion,
  decodeUrl,
}: {
  background: string | undefined;
  pending: boolean;
  visibility: number;
  blur: number;
  reducedMotion: boolean;
  decodeUrl?: string;
}) {
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const decoded = useRef(new Set<string>());
  const [, setDecodedRevision] = useState(0);
  const imageReady = !decodeUrl || decoded.current.has(decodeUrl);
  useEffect(() => {
    if (!decodeUrl || imageReady) return;
    let current = true;
    const image = new Image();
    image.src = decodeUrl;
    const decode = async () => {
      try {
        await image.decode();
        if (!current) return;
        decoded.current.add(decodeUrl);
        setDecodedRevision((value) => value + 1);
      } catch {
        // Keep the displayed background if a custom image cannot decode.
      }
    };
    void decode();
    return () => {
      current = false;
    };
  }, [decodeUrl, imageReady]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const stopTransition = () => {
      clearTimeout(transitionTimer.current);
      delete root.dataset.wallpaperTransition;
      root.style.removeProperty('--app-wallpaper-previous-image');
    };
    const previous = root.style.getPropertyValue('--app-wallpaper-image');
    // A download, disk-cache lookup or decode must not replace a displayed
    // original with the next thumbnail. A failed selection also retains it.
    const next = background && (pending || !imageReady) && previous ? previous : background;
    if (!next) {
      stopTransition();
      delete root.dataset.wallpaperActive;
      root.style.removeProperty('--app-wallpaper-image');
      root.style.removeProperty('--app-wallpaper-veil');
    } else {
      root.dataset.wallpaperActive = 'true';
      root.style.setProperty('--app-wallpaper-veil', `${100 - visibility * 100}%`);
      if (reducedMotion || visibility === 0) stopTransition();
      if (next !== previous) {
        stopTransition();
        if (
          previous &&
          previous !== 'none' &&
          next !== 'none' &&
          visibility > 0 &&
          !reducedMotion
        ) {
          // Restart the opacity animation for rapid selections, without animating
          // the image property or any foreground content.
          void document.body.offsetWidth;
          root.style.setProperty('--app-wallpaper-previous-image', previous);
          root.dataset.wallpaperTransition = 'true';
          const token = getComputedStyle(root).getPropertyValue('--motion-fast').trim();
          const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
          transitionTimer.current = setTimeout(
            stopTransition,
            (Number.isFinite(duration) ? duration : 150) + 100,
          );
        }
        root.style.setProperty('--app-wallpaper-image', next);
      }
    }
    if (next && blur > 0 && visibility > 0) {
      root.dataset.wallpaperBlur = 'true';
      root.style.setProperty('--app-wallpaper-blur', `${blur}px`);
    } else {
      delete root.dataset.wallpaperBlur;
      root.style.removeProperty('--app-wallpaper-blur');
    }
  }, [background, pending, visibility, blur, reducedMotion, imageReady]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const finish = (event: AnimationEvent) => {
      if (event.target !== document.body || event.animationName !== 'app-wallpaper-image-out')
        return;
      clearTimeout(transitionTimer.current);
      delete root.dataset.wallpaperTransition;
      root.style.removeProperty('--app-wallpaper-previous-image');
    };
    document.body.addEventListener('animationend', finish);
    return () => {
      clearTimeout(transitionTimer.current);
      document.body.removeEventListener('animationend', finish);
      delete root.dataset.wallpaperActive;
      delete root.dataset.wallpaperBlur;
      delete root.dataset.wallpaperTransition;
      for (const name of [
        '--app-wallpaper-image',
        '--app-wallpaper-previous-image',
        '--app-wallpaper-veil',
        '--app-wallpaper-blur',
      ])
        root.style.removeProperty(name);
    };
  }, []);
}
