import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WallpaperId, WallpaperMotion } from '@/../shared/appearanceSettings';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useWallpaperVideoTier } from '@/hooks/useWallpaperVideoTier';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { getWallpaperVideo, usesCdnWallpaperVideo } from '@/lib/wallpaper';

/** One decoder and one viewport canvas. Static mode does not fetch any video. */
export function WallpaperVideo({
  wallpaperId,
  motion,
}: {
  wallpaperId: WallpaperId;
  motion: WallpaperMotion;
}) {
  const reducedMotion = useReducedMotion();
  const src = getWallpaperVideo(wallpaperId);
  if (reducedMotion || !src) return null;
  return <WallpaperPlayback key={wallpaperId} wallpaperId={wallpaperId} active={motion === 'dynamic'} />;
}

type PlaybackProps = { active: boolean; onExited: () => void };

function WallpaperPlayback({ wallpaperId, active }: { wallpaperId: WallpaperId; active: boolean }) {
  const [retained, setRetained] = useState(active);
  const onExited = useCallback(() => setRetained(false), []);
  useEffect(() => { if (active) setRetained(true); }, [active]);
  if (!active && !retained) return null;
  const src = getWallpaperVideo(wallpaperId)!;
  return usesCdnWallpaperVideo(wallpaperId)
    ? <AdaptiveWallpaper wallpaperId={wallpaperId} active={active} onExited={onExited} />
    : <PlayingWallpaper src={src} active={active} onExited={onExited} />;
}

function AdaptiveWallpaper({ wallpaperId, active, onExited }: { wallpaperId: WallpaperId } & PlaybackProps) {
  const tier = useWallpaperVideoTier();
  const [hdFailed, setHdFailed] = useState(false);
  const [hdSrc, setHdSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!active || tier !== 'hd' || hdFailed || hdSrc) return;
    let current = true;
    void window.electronAPI?.appearanceSettings?.ensureWallpaperVideo?.(wallpaperId)
      .then(url => { if (current) setHdSrc(url); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [wallpaperId, tier, hdFailed, hdSrc, active]);
  const useHd = tier === 'hd' && !hdFailed && !!hdSrc;
  const src = useHd ? hdSrc : getWallpaperVideo(wallpaperId);
  return src ? (
    <PlayingWallpaper
      key={src}
      src={src}
      active={active}
      onExited={onExited}
      onFailure={useHd ? () => setHdFailed(true) : undefined}
    />
  ) : null;
}

function PlayingWallpaper({ src, onFailure, active, onExited }: { src: string; onFailure?: () => void } & PlaybackProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (active) return;
    if (!ready || failed || !layerRef.current) {
      onExited();
      return;
    }
    // Bound decoder retention even when transitionend is suppressed (e.g. hidden
    // windows). Read the CSS token's resolved duration rather than duplicating it.
    const duration = getComputedStyle(layerRef.current).transitionDuration;
    const ms = (parseFloat(duration) || 0) * (duration.endsWith('ms') ? 1 : 1000);
    const timeout = window.setTimeout(onExited, ms);
    return () => window.clearTimeout(timeout);
  }, [active, ready, failed, onExited]);

  useLayoutEffect(() => {
    if (!ready || failed) return;
    document.documentElement.dataset.wallpaperMotion = 'dynamic';
    return () => {
      delete document.documentElement.dataset.wallpaperMotion;
    };
  }, [ready, failed]);

  useEffect(() => {
    const video = ref.current;
    if (!video || failed) return;
    // Effect replay (StrictMode/HMR) may follow a cleanup on the same element.
    video.src = src;
    let generation = 0;
    const sync = () => {
      const current = ++generation;
      // The shared gate also covers Electron minimize/hide with throttling disabled.
      if (document.hidden || document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR)) {
        video.pause();
      } else {
        void video.play().catch(() => {
          if (generation === current) {
            setFailed(true);
            onFailureRef.current?.();
          }
        });
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [HIDDEN_ANIMATION_ATTR],
    });
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      generation++;
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [failed, src]);

  if (failed) return null;
  return createPortal(
    <div
      ref={layerRef}
      className="app-wallpaper-video"
      aria-hidden="true"
      style={{ opacity: ready && active ? 1 : 0 }}
      onTransitionEnd={event => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity' && !active) onExited();
      }}
    >
      <video
        ref={ref}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        onPlaying={() => setReady(true)}
        onError={() => {
          setFailed(true);
          onFailureRef.current?.();
        }}
      />
    </div>,
    document.body,
  );
}
