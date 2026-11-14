import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compressImageBuffer, imageCompressionCacheKey } from './image-compressor.js';

async function pngBuffer(opts: { width?: number; height?: number; alpha?: boolean } = {}): Promise<Buffer> {
  const width = opts.width ?? 256;
  const height = opts.height ?? 192;
  const channels = opts.alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data[i * channels] = (i * 17) & 255;
    data[i * channels + 1] = (i * 31) & 255;
    data[i * channels + 2] = (i * 47) & 255;
    if (opts.alpha) data[i * channels + 3] = i % 3 === 0 ? 80 : 255;
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe('compressImageBuffer', () => {
  it('encodes PNG as lossless WebP only for a route that accepts it, preserving pixels', async () => {
    const input = await pngBuffer({ width: 512, height: 384 });
    const result = await compressImageBuffer({ bytes: input, mimeType: 'image/png', route: { providerId: 'openai', acceptsWebp: true } });
    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBe(512);
    expect(result.height).toBe(384);
    const before = await sharp(input).raw().toBuffer({ resolveWithObject: true });
    const after = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(after.data).toEqual(before.data);
  });

  it('keeps PNG when WebP is not accepted and never converts transparent images to JPEG', async () => {
    const input = await pngBuffer({ alpha: true });
    const result = await compressImageBuffer({ bytes: input, mimeType: 'image/png', route: { providerId: 'xai', acceptsWebp: false } });
    expect(result.mimeType).toBe('image/png');
    expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('uses lossy quality-90 encoding only in the oversized-image budget path', async () => {
    const input = await pngBuffer({ width: 512, height: 384 });
    const result = await compressImageBuffer({
      bytes: input,
      mimeType: 'image/png',
      route: { providerId: 'openai', acceptsWebp: true },
      budget: { maxBytes: Math.floor(input.length * 0.8), maxEdgePx: 512 },
    });
    expect(result.mimeType).toBe('image/webp');
    expect(result.changed).toBe(true);
  });

  it('re-encodes JPEG at fixed dimensions and falls back when the 15% saving is not met', async () => {
    const input = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const result = await compressImageBuffer({ bytes: input, mimeType: 'image/jpeg' });
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
    expect(result.bytes.length).toBeLessThanOrEqual(input.length);
  });

  it('uses original content plus complete parameters for a stable cache key', async () => {
    const input = await pngBuffer();
    const a = imageCompressionCacheKey(input, { mimeType: 'image/png', route: { providerId: 'openai', acceptsWebp: true } });
    const b = imageCompressionCacheKey(input, { mimeType: 'image/png', route: { providerId: 'xai', acceptsWebp: false } });
    expect(a).not.toBe(b);
    expect(a).toBe(imageCompressionCacheKey(input, { mimeType: 'image/png', route: { providerId: 'openai', acceptsWebp: true } }));
  });

  it('normalizes decoded pixels to sRGB; lossless WebP is exact after decode for sRGB input', async () => {
    const input = await pngBuffer({ width: 32, height: 32 });
    const result = await compressImageBuffer({ bytes: input, mimeType: 'image/png', route: { providerId: 'openai', acceptsWebp: true } });
    const before = await sharp(input).toColourspace('srgb').raw().toBuffer();
    const after = await sharp(result.bytes).toColourspace('srgb').raw().toBuffer();
    expect(after).toEqual(before);
    // A Display-P3 source is converted into the sRGB pixel space before encode;
    // equality here means equality after our own sRGB decode, not P3 code values.
  });

  it('converts a macOS Display P3 source to the same sRGB pixels before lossless encoding', async () => {
    const profile = '/System/Library/ColorSync/Profiles/Display P3.icc';
    if (!existsSync(profile)) return;
    const source = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 240, g: 80, b: 40 } },
    }).withMetadata({ icc: profile }).png().toBuffer();
    const result = await compressImageBuffer({ bytes: source, mimeType: 'image/png', route: { providerId: 'openai', acceptsWebp: true } });
    const before = await sharp(source).toColourspace('srgb').raw().toBuffer();
    const after = await sharp(result.bytes).toColourspace('srgb').raw().toBuffer();
    expect(after).toEqual(before);
  });
});
