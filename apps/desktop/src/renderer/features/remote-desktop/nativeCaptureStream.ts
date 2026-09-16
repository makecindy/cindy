import type { RemoteDesktopCursor, RemoteDesktopCursorFrame } from '@cindy/device-link';
/** Converts the bounded native fallback frames into the existing WebRTC video
 * transport. Serial pulls/decode keep both IPC and image memory bounded.
 */
export async function nativeCaptureStream(
  read: () => Promise<string | RemoteDesktopCursorFrame | null>,
  alive: () => boolean,
  failed: () => void,
  cursor: (value: RemoteDesktopCursor | null) => void = () => {},
  fps = 15,
): Promise<{ stream: MediaStream; stop(): void; clear(): void }> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  let lastFrame = performance.now();
  const draw = async () => {
    const current = epoch;
    const frame = await read();
    const jpeg = typeof frame === 'string' ? frame : frame?.jpeg;
    if (!jpeg || stopped || !alive() || current !== epoch) return false;
    const bytes = Uint8Array.from(atob(jpeg), (value) => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    try {
      if (stopped || !alive() || current !== epoch) return false;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      if (frame && typeof frame !== 'string') cursor(frame.cursor);
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
    try {
      await draw();
      if (performance.now() - lastFrame > 5000) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
      if (!stopped && alive()) timer = setTimeout(() => void pull(), Math.round(1000 / fps));
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
  };
}
