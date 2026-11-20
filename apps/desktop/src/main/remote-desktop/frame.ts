import type { NativeImage } from 'electron';
import type { RemoteDesktopCursorFrame } from '@cindy/device-link';

// This is a sender budget, not a new wire limit: old viewers still accept it.
// Base64 plus cursor/envelope overhead stays below the 128 KiB reliable chunk,
// so a fallback image does not hold the stream waiting for its second segment.
const RELAY_FRAME_TARGET_BYTES = 64 * 1024;
const RELAY_REPLY_TARGET_BYTES = 96 * 1024;

/** Capture can briefly produce an empty thumbnail even with permission granted. */
export function encodeDesktopFrame(
  thumbnail: NativeImage,
  maxBytes = RELAY_FRAME_TARGET_BYTES,
): string | null {
  if (thumbnail.isEmpty()) return null;
  let image = thumbnail;
  for (let attempt = 0; attempt < 4; attempt++) {
    const jpeg = image.toJPEG(55);
    if (jpeg.length <= maxBytes) return jpeg.toString('base64');
    // Large/high-detail displays need more than a fixed 25% shrink to fit in
    // four attempts. Estimate area reduction, with headroom for JPEG overhead.
    const scale = Math.min(0.75, Math.sqrt(maxBytes / jpeg.length) * 0.9);
    image = image.resize({ width: Math.max(1, Math.floor(image.getSize().width * scale)) });
  }
  return null; // Drop only this frame; oversized captures must not restart the lease.
}

/** Bound native captures only at the relay adapter; local WebRTC keeps full quality. */
export function encodeNativeRelayFrame(
  frame: string | RemoteDesktopCursorFrame | null,
  decode: (jpeg: Buffer) => NativeImage,
): string | RemoteDesktopCursorFrame | null {
  const jpeg = typeof frame === 'object' && frame !== null ? frame.jpeg : frame;
  if (!jpeg) return frame;
  // A custom cursor can itself carry 64 KiB of PNG text. Reserve its actual
  // serialized size before assigning the JPEG budget, rather than dropping it.
  const metadataBytes = typeof frame === 'object' && frame !== null
    ? Buffer.byteLength(JSON.stringify({ ...frame, jpeg: '' }), 'utf8')
    : 0;
  const maxBytes = Math.min(
    RELAY_FRAME_TARGET_BYTES,
    Math.floor((RELAY_REPLY_TARGET_BYTES - metadataBytes - 2048) * 3 / 4),
  );
  if (maxBytes <= 0) return null;
  if (jpeg.length <= Math.ceil(maxBytes / 3) * 4) return frame;
  const encoded = encodeDesktopFrame(decode(Buffer.from(jpeg, 'base64')), maxBytes);
  if (encoded === null) return null;
  return typeof frame === 'object' && frame !== null ? { ...frame, jpeg: encoded } : encoded;
}
