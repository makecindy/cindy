import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { copyPngToClipboard } from '../pngClipboard';
import { MAX_CLIPBOARD_PNG_BYTES } from '../../shared/pngClipboard';
import { throwIpcError } from '../utils/ipcValidate';

// Real 1×1 PNG; dimension mutations exercise rejection before native decoding.
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const png = () => Uint8Array.from(pngBytes).buffer;
const event = {} as IpcMainInvokeEvent;

function harness() {
  const image = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) } as NativeImage;
  return { image, assertTrustedSender: vi.fn(), decode: vi.fn(() => image), write: vi.fn() };
}

describe('copyPngToClipboard', () => {
  it.each([undefined, 'graph TD; A-->B'])(
    'writes PNG and optional source text atomically: %s',
    (plainText) => {
      const deps = harness();
      copyPngToClipboard(event, { png: png(), plainText }, deps);
      expect(deps.assertTrustedSender).toHaveBeenCalledWith(event);
      expect(deps.decode).toHaveBeenCalledWith(pngBytes);
      expect(deps.write.mock.calls).toEqual([
        [{ image: deps.image, ...(plainText ? { text: plainText } : {}) }],
      ]);
    },
  );

  it('rejects an untrusted sender before inspecting payload or decoding', () => {
    const deps = harness();
    deps.assertTrustedSender.mockImplementation(() => throwIpcError('PERMISSION_DENIED', 'Denied'));
    expect(() => copyPngToClipboard(event, null, deps)).toThrow('[PERMISSION_DENIED]');
    expect(deps.decode).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { png: 'file:///tmp/image.png' },
    { png: new ArrayBuffer(32) },
    { png: new ArrayBuffer(33) },
    { png: png(), plainText: 42 },
    { png: png(), plainText: 'x'.repeat(4 * 1024 * 1024 + 1) },
  ])('rejects malformed payload without touching clipboard', (input) => {
    const deps = harness();
    expect(() => copyPngToClipboard(event, input, deps)).toThrow('[INVALID_PARAMS]');
    expect(deps.decode).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('rejects oversized encoded bytes before decoding', () => {
    const deps = harness();
    expect(() =>
      copyPngToClipboard(event, { png: new ArrayBuffer(MAX_CLIPBOARD_PNG_BYTES + 1) }, deps),
    ).toThrow('[INVALID_PARAMS]');
    expect(deps.decode).not.toHaveBeenCalled();
  });

  it.each([
    [0, 1],
    [1, 16_385],
    [16_385, 1],
    [5000, 5000],
  ])('rejects unsafe dimensions %s × %s before decoding', (width, height) => {
    const data = png();
    const view = new DataView(data);
    view.setUint32(16, width);
    view.setUint32(20, height);
    const deps = harness();
    expect(() => copyPngToClipboard(event, { png: data }, deps)).toThrow('[INVALID_PARAMS]');
    expect(deps.decode).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('supports a bounded long conversation image', () => {
    const data = png();
    new DataView(data).setUint32(16, 800);
    new DataView(data).setUint32(20, 16_384);
    const deps = harness();
    deps.image.getSize = () => ({ width: 800, height: 16_384 });
    copyPngToClipboard(event, { png: data }, deps);
    expect(deps.write).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'throw', 'dimensions'])(
    'leaves clipboard untouched on decode failure: %s',
    (failure) => {
      const deps = harness();
      if (failure === 'empty') deps.image.isEmpty = () => true;
      if (failure === 'dimensions') deps.image.getSize = () => ({ width: 2, height: 2 });
      if (failure === 'throw')
        deps.decode.mockImplementation(() => {
          throw new Error('decoder details');
        });
      expect(() => copyPngToClipboard(event, { png: png() }, deps)).toThrow('[INVALID_PARAMS]');
      expect(deps.write).not.toHaveBeenCalled();
    },
  );

  it('reports write failures without leaking native error details', () => {
    const deps = harness();
    deps.write.mockImplementation(() => {
      throw new Error('private native details');
    });
    expect(() => copyPngToClipboard(event, { png: png() }, deps)).toThrow(
      '[INTERNAL] Unable to write PNG to clipboard',
    );
  });
});
