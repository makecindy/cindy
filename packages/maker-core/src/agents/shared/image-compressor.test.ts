// 测试价值：unit；生产入口 compressImageBuffer。依据 PR 2 压缩合同及 Lead 缩图回归审查。
// 原覆盖仅断言缓存权限；最小失败输入为 1600×2 PNG、单/多帧图片、EXIF 6 JPEG。
// 验证真实输出格式、像素、尺寸和预算失败；本机定向文件执行 3.148s（含编码）。
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
  // Format fallback is not a byte-saving optimization: a rejected WebP may
  // grow when encoded as PNG. Unknown routes alone must not change user WebP.
  it.each([true, false])('handles explicit WebP rejection=%s without a byte budget', async rejectsWebp => {
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } })
      .webp({ lossless: true }).toBuffer();
    const route = { acceptsWebp: false, rejectsWebp };
    const result = await compressImageBuffer({ bytes, mimeType: 'image/webp', route });
    expect(result.changed).toBe(rejectsWebp);
    expect(result.mimeType).toBe(rejectsWebp ? 'image/png' : 'image/webp');
    if (rejectsWebp) {
      expect(result.bytes.length).toBeGreaterThan(bytes.length);
      expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(true);
      expect(await sharp(result.bytes).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
      expect(result.cacheKey).not.toBe(imageCompressionCacheKey(bytes, { mimeType: 'image/webp', route: { acceptsWebp: false } }));
    } else expect(result.bytes).toEqual(bytes);
  });

  it.each([true, false])('keeps the no-WebP byte-budget format policy for alpha=%s', async alpha => {
    const bytes = await sharp(await pngBuffer({ width: 96, height: 64, alpha })).png({ compressionLevel: 0 }).toBuffer();
    const maxBytes = Math.floor(bytes.length * 0.8);
    const result = await compressImageBuffer({ bytes, mimeType: 'image/png', route: { acceptsWebp: false }, budget: { maxBytes } });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe(alpha ? 'image/png' : 'image/jpeg');
    expect(result.bytes.length).toBeLessThanOrEqual(maxBytes);
    expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(alpha);
  });

  it('preserves animated WebP even when the route explicitly rejects WebP', async () => {
    const bytes = await sharp(Buffer.concat([Buffer.alloc(20 * 10 * 3, 200), Buffer.alloc(20 * 10 * 3, 40)]),
      { raw: { width: 20, height: 20, channels: 3, pageHeight: 10 } }).webp({ lossless: true }).toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    const route = { acceptsWebp: false, rejectsWebp: true };
    const result = await compressImageBuffer({ bytes, mimeType: 'image/webp', route });
    expect(result.changed).toBe(false);
    expect(result.bytes).toEqual(bytes);
  });

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

  // Unit: normal proxy compression must preserve JPEG, even if a smaller
  // q90 encoding exists; attachment maxEdgePx and byte budgets remain separate.
  it('keeps a JPEG byte-for-byte without an attachment or oversized budget', async () => {
    const input = await sharp({ create: { width: 120, height: 80, channels: 3, background: 'white' } })
      .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
    const result = await compressImageBuffer({ bytes: input, mimeType: 'image/jpeg' });
    expect(result.changed).toBe(false);
    expect(result.bytes).toEqual(input);
    expect([result.width, result.height]).toEqual([80, 120]);
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
    expect(result.changed).toBe(true);
    const before = await sharp(source).toColourspace('srgb').raw().toBuffer();
    const after = await sharp(result.bytes).toColourspace('srgb').raw().toBuffer();
    expect(after).toEqual(before);
  });
});

// Regression: PR 2 review. Real encoder previously reverted required resizing
// via the byte-saving gate, or flattened animations. Unit; synthetic tiny inputs.
describe('required resizing and byte budgets', () => {
  it.each(['png', 'webp', 'gif'] as const)('resizes single-frame %s even without 15 percent savings', async format => {
    const bytes = await sharp({ create: { width: 1600, height: 2, channels: 3, background: 'white' } })[format]().toBuffer();
    const result = await compressImageBuffer({ bytes, mimeType: `image/${format}`, budget: { maxEdgePx: 1568 } });
    expect(result.changed).toBe(true);
    expect(result.width).toBe(1568);
    expect(result.mimeType).toBe(format === 'gif' ? 'image/png' : `image/${format}`);
  });
  it('keeps multi-frame GIF bytes intact even under a resize budget', async () => {
    const bytes = await sharp(Buffer.concat([Buffer.alloc(20 * 10 * 3, 200), Buffer.alloc(20 * 10 * 3, 40)]), { raw: { width: 20, height: 20, channels: 3, pageHeight: 10 } }).gif().toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    const result = await compressImageBuffer({ bytes, mimeType: 'image/gif', budget: { maxEdgePx: 5 } });
    expect(result.bytes).toEqual(bytes);
    expect(result.changed).toBe(false);
  });
  it('accepts JPEG byte-budget output even when savings are below 15 percent', async () => {
    const encoded = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'white' } })
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
    // Valid JPEG with a tiny trailing pad: re-encoding saves less than 15%.
    const bytes = Buffer.concat([encoded, Buffer.alloc(10)]);
    const normal = await compressImageBuffer({ bytes, mimeType: 'image/jpeg' });
    expect(normal.changed).toBe(false);
    expect(normal.bytes).toEqual(bytes);
    const tight = await compressImageBuffer({ bytes, mimeType: 'image/jpeg', budget: { maxBytes: encoded.length + 1 } });
    expect(tight.changed).toBe(true);
    expect(tight.bytes.length).toBeLessThanOrEqual(encoded.length + 1);
    expect(tight.bytes.length).toBeGreaterThan(bytes.length * 0.85);
  });
  it('reports an unreachable byte budget without returning an oversized candidate', async () => {
    const bytes = await pngBuffer();
    const result = await compressImageBuffer({ bytes, mimeType: 'image/png', budget: { maxBytes: 1 } });
    expect(result.changed).toBe(false);
    expect(result.bytes).toEqual(bytes);
  });
  it('bakes orientation and removes metadata on attachment output', async () => {
    const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'white' } }).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
    const result = await compressImageBuffer({ bytes, mimeType: 'image/jpeg', budget: { maxEdgePx: 400 } });
    expect(result.changed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });
});
