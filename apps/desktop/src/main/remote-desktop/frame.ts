import type { NativeImage } from 'electron';
import { REMOTE_DESKTOP_MAX_FRAME_BYTES, type RemoteDesktopCursorFrame } from '@cindy/device-link';

/** Capture can briefly produce an empty thumbnail even with permission granted. */
export function encodeDesktopFrame(thumbnail: NativeImage): string | null {
  if (thumbnail.isEmpty()) return null;
  let image = thumbnail;
  for (let attempt = 0; attempt < 4; attempt++) {
    const jpeg = image.toJPEG(55);
    if (jpeg.length <= REMOTE_DESKTOP_MAX_FRAME_BYTES) return jpeg.toString('base64');
    image = image.resize({ width: Math.floor(image.getSize().width * 0.75) });
  }
  return null; // Drop only this frame; oversized captures must not restart the lease.
}

/** Bound native captures only at the relay adapter; local WebRTC keeps full quality. */
export function encodeNativeRelayFrame(
  frame: string | RemoteDesktopCursorFrame | null,
  decode: (jpeg: Buffer) => NativeImage,
): string | RemoteDesktopCursorFrame | null {
  const jpeg = typeof frame === 'object' && frame !== null ? frame.jpeg : frame;
  if (!jpeg || jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4) return frame;
  const encoded = encodeDesktopFrame(decode(Buffer.from(jpeg, 'base64')));
  if (encoded === null) return null;
  return typeof frame === 'object' && frame !== null ? { ...frame, jpeg: encoded } : encoded;
}
