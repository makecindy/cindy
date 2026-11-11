import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WallpaperId, WallpaperMotion } from '@/../shared/appearanceSettings';
import {
  isCustomWallpaperVideo,
  normalizeCustomWallpaperUrl,
} from '@/../shared/appearanceSettings';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { isSceneWallpaper } from '@/lib/wallpaper';
import { createLogger } from '@/lib/logger';

const log = createLogger('wallpaper-video');

/** One decoder and one viewport canvas. Custom videos retain a paused frame in static mode. */
export function WallpaperVideo({
  wallpaperId,
  motion,
  customWallpaperUrl,
  officialVideoUrl,
  onFailure,
  onReady,
}: {
  wallpaperId: WallpaperId;
  motion: WallpaperMotion;
  customWallpaperUrl?: string;
  officialVideoUrl?: string | null;
  onFailure?: () => void;
  onReady?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  if (wallpaperId === 'custom' && isCustomWallpaperVideo(customWallpaperUrl)) {
    const src = normalizeCustomWallpaperUrl(customWallpaperUrl);
    return (
      <PlayingWallpaper
        key={src}
        src={src}
        active
        playing={motion === 'dynamic' && !reducedMotion}
        onFailure={onFailure}
        onReady={onReady}
      />
    );
  }
  const src = officialVideoUrl;
  if (reducedMotion || !isSceneWallpaper(wallpaperId) || !src) return null;
  return <WallpaperPlayback key={wallpaperId} src={src} active={motion === 'dynamic'} />;
}

function WallpaperPlayback({ src, active }: { src: string; active: boolean }) {
  const [retained, setRetained] = useState(active);
  const onExited = useCallback(() => setRetained(false), []);
  useEffect(() => {
    if (active) setRetained(true);
  }, [active]);
  if (!active && !retained) return null;
  return <PlayingWallpaper key={src} src={src} active={active} onExited={onExited} />;
}

function PlayingWallpaper({
  src,
  onFailure,
  active,
  onExited,
  playing = true,
  onReady,
}: {
  src: string;
  onFailure?: () => void;
  active: boolean;
  onExited?: () => void;
  playing?: boolean;
  onReady?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const syncPlaybackRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (active) return;
    if (!ready || failed || !layerRef.current) {
      onExited?.();
      return;
    }
    // Bound decoder retention even when transitionend is suppressed (e.g. hidden
    // windows). Read the CSS token's resolved duration rather than duplicating it.
    const duration = getComputedStyle(layerRef.current).transitionDuration;
    const ms = (parseFloat(duration) || 0) * (duration.endsWith('ms') ? 1 : 1000);
    const timeout = window.setTimeout(() => onExited?.(), ms);
    return () => window.clearTimeout(timeout);
  }, [active, ready, failed, onExited]);

  useLayoutEffect(() => {
    if (!ready || failed) return;
    // A paused custom frame still lives on the video canvas; keep the composer
    // transparent instead of painting the image-only fallback over that frame.
    document.documentElement.dataset.wallpaperMotion = 'dynamic';
    return () => {
      delete document.documentElement.dataset.wallpaperMotion;
    };
  }, [ready, failed]);

  useEffect(() => {
    syncPlaybackRef.current();
    if (!playing && (ref.current?.readyState ?? 0) >= 2) setReady(true);
  }, [playing]);

  useEffect(() => {
    const video = ref.current;
    if (!video || failed) return;
    // Effect replay (StrictMode/HMR) may follow a cleanup on the same element.
    video.src = src;
    let generation = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryAttempts = 0;
    let interrupted = false;
    const hidden = () =>
      document.hidden || document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR);
    const cancelRecovery = () => {
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    };
    const recover = () => {
      if (recoveryTimer !== undefined || hidden() || !playingRef.current || recoveryAttempts >= 2)
        return;
      // Only interrupted playback owns a timer. No polling/decoder work while
      // hidden, and a broken source cannot cause an unbounded reload loop.
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (hidden() || !playingRef.current) return;
        recoveryAttempts++;
        log.warn('Reloading interrupted wallpaper playback', {
          attempt: recoveryAttempts,
          readyState: video.readyState,
          networkState: video.networkState,
          mediaError: video.error?.code ?? null,
        });
        video.src = src;
        video.load();
        sync();
        recover();
      }, 5_000);
    };
    const onInterrupted = (event: Event) => {
      // A stalled download can still have a valid paused/current frame. Keep it
      // unless the decoder is actually waiting or has discarded its data.
      if (event.type === 'stalled' && video.readyState >= 2) return;
      if (!playingRef.current && video.readyState >= 2) return;
      interrupted = true;
      setReady(false);
      recover();
    };
    const onPlaying = () => {
      interrupted = false;
      cancelRecovery();
    };
    const sync = () => {
      const current = ++generation;
      // The shared gate also covers Electron minimize/hide with throttling disabled.
      if (
        !playingRef.current ||
        document.hidden ||
        document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR)
      ) {
        cancelRecovery();
        video.pause();
      } else {
        if (interrupted) recover();
        void video.play().catch(() => {
          if (generation === current) {
            log.warn('Wallpaper playback rejected', { mediaError: video.error?.code ?? null });
            setFailed(true);
            onFailureRef.current?.();
          }
        });
      }
    };
    syncPlaybackRef.current = sync;
    for (const event of ['waiting', 'emptied', 'stalled'])
      video.addEventListener(event, onInterrupted);
    video.addEventListener('playing', onPlaying);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [HIDDEN_ANIMATION_ATTR],
    });
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      generation++;
      cancelRecovery();
      for (const event of ['waiting', 'emptied', 'stalled'])
        video.removeEventListener(event, onInterrupted);
      video.removeEventListener('playing', onPlaying);
      syncPlaybackRef.current = () => {};
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
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity' && !active)
          onExited?.();
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
        onLoadedData={() => {
          if (!playingRef.current) setReady(true);
          onReady?.();
        }}
        onPlaying={() => {
          setReady(true);
          onReady?.();
        }}
        onError={() => {
          log.warn('Wallpaper media failed', { mediaError: ref.current?.error?.code ?? null });
          setFailed(true);
          onFailureRef.current?.();
        }}
      />
    </div>,
    document.body,
  );
}
