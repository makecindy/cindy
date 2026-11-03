import type { RemoteDesktopCursor, RemoteDesktopCursorFrame } from '@cindy/device-link';
import { DESKTOP_MOTION, desktopFrameChange } from '../../../shared/remoteDesktopQuality';
/** Converts the bounded native fallback frames into the existing WebRTC video
 * transport. Serial pulls/decode keep both IPC and image memory bounded.
 */
export async function nativeCaptureStream(
  read: () => Promise<string | RemoteDesktopCursorFrame | null>,
  alive: () => boolean,
  failed: () => void,
  cursor: (value: RemoteDesktopCursor | null) => void = () => {},
  fps = 15,
  onMotion?: (moving: boolean) => void,
): Promise<{
  stream: MediaStream;
  stop(): void;
  clear(): void;
  hold(): void;
  resume(): boolean;
}> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  // A tiny thumbnail separates large changes (scrolling, video) from small
  // localized activity (caret, pulsing button) at negligible cost.
  const thumb = onMotion ? document.createElement('canvas') : null;
  const thumbContext = thumb?.getContext('2d', { willReadFrequently: true });
  if (thumb) thumb.width = 64;
  if (thumb) thumb.height = 36;
  let lastThumb: Uint8ClampedArray | null = null;
  let lastMotion = 0;
  let moving = true;
  const observe = (bitmap: ImageBitmap) => {
    if (!thumbContext || !onMotion) return;
    thumbContext.drawImage(bitmap, 0, 0, 64, 36);
    const next = thumbContext.getImageData(0, 0, 64, 36).data;
    const now = performance.now();
    if (!lastThumb || desktopFrameChange(lastThumb, next) > DESKTOP_MOTION.changedShare)
      lastMotion = now;
    lastThumb = next;
    const nextMoving = now - lastMotion < DESKTOP_MOTION.stillAfterMs;
    if (nextMoving !== moving) {
      moving = nextMoving;
      onMotion(moving);
    }
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  let lastFrame = performance.now();
  // A display change yields no frames for a while; it must not end the stream.
  let held = false;
  const draw = async () => {
    const current = epoch;
    const frame = await read();
    const jpeg = typeof frame === 'string' ? frame : frame?.jpeg;
    if (!frame || !jpeg || stopped || !alive() || current !== epoch) return false;
    const binary = atob(jpeg);
    const bytes = new Uint8Array(binary.length);
    // Avoid Uint8Array.from's per-character iterator/callback on large frames.
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    try {
      if (stopped || !alive() || current !== epoch) return false;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      observe(bitmap);
      // A fallback frame includes the pointer in its pixels. Clear the last
      // independent cursor so switching backends cannot leave two pointers.
      cursor(typeof frame === 'string' ? null : frame.cursor);
      lastFrame = performance.now();
      return true;
    } finally {
      bitmap.close();
    }
  };
  if (!(await draw())) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  const stream = canvas.captureStream(fps);
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    canvas.width = canvas.height = 1;
  };
  const pull = async () => {
    if (stopped || !alive()) {
      stop();
      return;
    }
    const started = performance.now();
    try {
      await draw();
      if (!held && performance.now() - lastFrame > 5000)
        throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
      if (!stopped && alive())
        timer = setTimeout(
          () => void pull(),
          Math.max(0, 1000 / fps - (performance.now() - started)),
        );
      else stop();
    } catch {
      stop();
      if (alive()) failed();
    }
  };
  timer = setTimeout(() => void pull(), Math.round(1000 / fps));
  return {
    stream,
    stop,
    clear: () => {
      epoch++;
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
    hold: () => {
      held = true;
    },
    // Drop frames already requested for the previous display; keep the picture.
    // False when the stream already ended, so the caller rebuilds instead.
    resume: () => {
      if (stopped || stream.getVideoTracks()[0]?.readyState !== 'live') return false;
      held = false;
      epoch++;
      lastFrame = performance.now();
      return true;
    },
  };
}
