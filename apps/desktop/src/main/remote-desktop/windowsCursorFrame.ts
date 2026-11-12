import { isRemoteDesktopCursor, type RemoteDesktopCursorFrame } from '@cindy/device-link';

type EncodeCursor = (bgra: Buffer, size: { width: number; height: number }) => Buffer;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Convert bounded local BGRA into the existing cross-device PNG cursor contract.
 * Invalid/unavailable cursor metadata drops only the overlay, never the desktop picture.
 */
export function decodeWindowsCursorFrame(
  text: string,
  scaleFactor: number,
  encode: EncodeCursor,
): string | RemoteDesktopCursorFrame {
  if (text.length <= 240000 && base64.test(text)) return text; // older installed helper
  if (text.length > 1_750_000) throw new Error('INVALID_CURSOR_FRAME');
  const frame: unknown = JSON.parse(text);
  if (
    !frame ||
    typeof frame !== 'object' ||
    !('jpeg' in frame) ||
    typeof frame.jpeg !== 'string' ||
    frame.jpeg.length > 1_333_336 ||
    !base64.test(frame.jpeg)
  )
    throw new Error('INVALID_CURSOR_FRAME');
  const result: RemoteDesktopCursorFrame = { jpeg: frame.jpeg, cursor: null };
  if (!('cursor' in frame) || !frame.cursor || typeof frame.cursor !== 'object') return result;
  const raw = frame.cursor as Record<string, unknown>;
  const { width, height, bgra } = raw;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    width > 256 ||
    height < 1 ||
    height > 256 ||
    typeof bgra !== 'string' ||
    bgra.length !== Math.ceil((width * height * 4) / 3) * 4 ||
    !base64.test(bgra)
  )
    return result;
  const geometry = [raw.x, raw.y, raw.hotX, raw.hotY];
  if (
    !geometry.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    typeof raw.visible !== 'boolean'
  )
    return result;
  const x = raw.x as number,
    y = raw.y as number,
    hotX = raw.hotX as number,
    hotY = raw.hotY as number;
  if (x < 0 || x > 1 || y < 0 || y > 1 || hotX < 0 || hotX > width || hotY < 0 || hotY > height)
    return result;
  const pixels = Buffer.from(bgra, 'base64');
  if (pixels.length !== width * height * 4) return result;
  try {
    const png = encode(pixels, { width, height });
    if (png.length > 49152) return result;
    const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const cursor = {
      visible: raw.visible,
      x,
      y,
      width: width / scale,
      height: height / scale,
      hotX: hotX / scale,
      hotY: hotY / scale,
      png: png.toString('base64'),
      ...(typeof raw.shape === 'string' && raw.shape.length <= 32 ? { shape: raw.shape } : {}),
    };
    if (isRemoteDesktopCursor(cursor)) result.cursor = cursor;
  } catch {
    /* Cursor conversion must not tear down video or input. */
  }
  return result;
}
