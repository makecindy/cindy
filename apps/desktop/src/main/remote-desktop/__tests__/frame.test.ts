import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { encodeDesktopFrame, encodeNativeRelayFrame } from '../frame';
import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';

function image(empty: boolean, bytes = Buffer.from('jpeg')) {
  const thumbnail = {
    isEmpty: () => empty,
    toJPEG: vi.fn(() => bytes),
    getSize: () => ({ width: 1280, height: 720 }),
    resize: vi.fn(() => thumbnail),
  };
  return thumbnail as unknown as NativeImage;
}

describe('desktop fallback frames', () => {
  it('treats an empty thumbnail as no frame, not a permission denial', () => {
    const thumbnail = image(true);
    expect(encodeDesktopFrame(thumbnail)).toBeNull();
    expect(thumbnail.toJPEG).not.toHaveBeenCalled();
    expect(encodeDesktopFrame(image(false))).toBe(Buffer.from('jpeg').toString('base64'));
  });
  it.each([false, true])('compresses oversized native relay frames, cursor overlay=%s', (overlay) => {
    const jpeg = Buffer.alloc(1_000_000).toString('base64');
    const compressed = Buffer.from('small jpeg');
    const thumbnail = image(false, compressed);
    const decode = vi.fn((_bytes: Buffer) => thumbnail);
    const frame = overlay ? { jpeg, cursor: null } : jpeg;
    const result = encodeNativeRelayFrame(frame, decode);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0][0].byteLength).toBe(1_000_000);
    expect(result).toEqual(overlay ? { jpeg: compressed.toString('base64'), cursor: null } : compressed.toString('base64'));
    expect(frame).toEqual(overlay ? { jpeg, cursor: null } : jpeg);
    const small = Buffer.alloc(40_000).toString('base64');
    decode.mockClear();
    expect(encodeNativeRelayFrame(small, decode)).toBe(small);
    expect(encodeNativeRelayFrame({ jpeg: small, cursor: null }, decode)).toEqual({ jpeg: small, cursor: null });
    expect(encodeNativeRelayFrame(null, decode)).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    decode.mockReturnValue(image(false, Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1)));
    expect(encodeNativeRelayFrame(frame, decode)).toBeNull();
  });
  // Unit regression: a valid 130 KB JPEG became a 174 KB base64 reply and
  // stalled a fragmented relay stream. Existing tests only covered the wire maximum.
  it('shrinks wire-valid captures before they occupy multiple relay chunks', () => {
    const original = image(false, Buffer.alloc(130_000));
    const smaller = image(false, Buffer.alloc(40_000));
    vi.mocked(original.resize).mockReturnValue(smaller);
    const frame = { jpeg: Buffer.alloc(130_000).toString('base64'), cursor: null };
    const result = encodeNativeRelayFrame(frame, () => original);
    expect(result).toEqual({ jpeg: Buffer.alloc(40_000).toString('base64'), cursor: null });
    expect(encodeDesktopFrame(original)).toBe(Buffer.alloc(40_000).toString('base64'));
  });
  it('reserves the cursor payload when bounding a native relay reply', () => {
    const frame = {
      jpeg: Buffer.alloc(60_000).toString('base64'),
      cursor: { visible: true, x: 0.5, y: 0.5, width: 256, height: 256,
        hotX: 0, hotY: 0, png: 'iVBORw0KGgo' + 'A'.repeat(65_000) },
    };
    const original = image(false, Buffer.alloc(60_000));
    vi.mocked(original.resize).mockReturnValue(image(false, Buffer.alloc(16_000)));
    const result = encodeNativeRelayFrame(frame, () => original);
    expect(result).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(96 * 1024);
    expect(typeof result === 'object' && result?.cursor).toBe(frame.cursor);
  });
  it('keeps the encoded frame size bounded', () => {
    const thumbnail = image(false, Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1));
    expect(encodeDesktopFrame(thumbnail)).toBeNull();
    expect(thumbnail.toJPEG).toHaveBeenCalledTimes(4);
  });
});
