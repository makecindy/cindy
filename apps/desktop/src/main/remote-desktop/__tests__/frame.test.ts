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
    const small = Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES).toString('base64');
    decode.mockClear();
    expect(encodeNativeRelayFrame(small, decode)).toBe(small);
    expect(encodeNativeRelayFrame({ jpeg: small, cursor: null }, decode)).toEqual({ jpeg: small, cursor: null });
    expect(encodeNativeRelayFrame(null, decode)).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    decode.mockReturnValue(image(false, Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1)));
    expect(encodeNativeRelayFrame(frame, decode)).toBeNull();
  });
  it('keeps the encoded frame size bounded', () => {
    const thumbnail = image(false, Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1));
    expect(encodeDesktopFrame(thumbnail)).toBeNull();
    expect(thumbnail.toJPEG).toHaveBeenCalledTimes(4);
  });
});
