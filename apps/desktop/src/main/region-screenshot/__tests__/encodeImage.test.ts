import type { NativeImage } from 'electron';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { encodeScreenshotImage } from '../encodeImage';

vi.mock('sharp', async original => {
  const actual = await original<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});

// Unit: the new async PNG branch must preserve pixels and leave alpha/JPEG on
// the native codec. No existing save/compose test exercises actual PNG encoding.
// Smallest branch input is 2000x1000; no Electron process, files or real waits.
function source(alpha = 255) {
  const pixels = Buffer.alloc(2000 * 1000 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([11, 57, 203, alpha], i);
  return {
    getSize: () => ({ width: 2000, height: 1000 }),
    toBitmap: () => Buffer.from(pixels),
    toPNG: () => Buffer.from('native-png'),
    toJPEG: (quality: number) => Buffer.from(`native-jpeg-${quality}`),
  } as NativeImage;
}

it('encodes opaque BGRA as lossless RGBA without modifying the source', async () => {
  const image = source(), before = image.toBitmap();
  const encoded = await encodeScreenshotImage(image);
  const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height, info.channels]).toEqual([2000, 1000, 4]);
  const expected = Buffer.alloc(data.length);
  for (let i = 0; i < expected.length; i += 4) expected.set([203, 57, 11, 255], i);
  expect(data.equals(expected)).toBe(true);
  expect(image.toBitmap().equals(before)).toBe(true);
});

it('keeps translucent PNG bytes on the original native path', async () => {
  const image = source(127);
  expect(await encodeScreenshotImage(image)).toEqual(image.toPNG());
});

it('keeps small PNGs and JPEG quality without reading raw pixels', async () => {
  const image = source();
  image.getSize = () => ({ width: 2, height: 2 });
  image.toBitmap = () => { throw new Error('unnecessary pixel extraction'); };
  expect(await encodeScreenshotImage(image)).toEqual(image.toPNG());
  expect(await encodeScreenshotImage(image, true)).toEqual(image.toJPEG(92));
});

it('falls back to the native PNG if the optional encoder fails', async () => {
  const image = source();
  vi.mocked(sharp).mockImplementationOnce(() => { throw new Error('native binding unavailable'); });
  expect(await encodeScreenshotImage(image)).toEqual(image.toPNG());
});
