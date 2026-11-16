import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressImageBuffer } from '@cindy/maker-core/image-compressor';
import { ImageResizer } from '../../../../../../packages/maker-core/src/agents/shared/image-resizer.js';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createInlineImagePreprocessor } from '../inlineImagePreprocessor.js';

// Unit: PR 2's public proxy callback. Existing resizer tests do not cover the
// learned MIME denial, runtime switch, abort, or cached callback behavior.
describe('inline image preprocessor', () => {
  const source = () => sharp({ create: { width: 128, height: 128, channels: 3, background: 'white' } }).png({ compressionLevel: 0 }).toBuffer();
  it('caches stable output and honors learned WebP denial on the same input', async () => {
    const bytes = await source();
    const input = { bytes, mimeType: 'image/png', route: { providerId: 'openai', modelId: 'gpt-6-astra' }, signal: new AbortController().signal };
    const processor = createInlineImagePreprocessor();
    const first = await processor.prepare(input);
    expect(first?.mimeType).toBe('image/webp');
    expect(await processor.prepare(input)).toBe(first);
    const denied = await processor.prepare({ ...input, route: { ...input.route, deniedMimeTypes: ['image/webp'] } });
    expect(denied?.mimeType).toBe('image/png');
    expect(await processor.prepare({ ...input, bytes: first!.bytes, mimeType: first!.mimeType })).toBeNull();
  });
  it('runtime disable and cancellation bypass cached results', async () => {
    let enabled = true;
    const processor = createInlineImagePreprocessor(() => enabled);
    const controller = new AbortController();
    const input = { bytes: await source(), mimeType: 'image/png', route: {}, signal: controller.signal };
    expect(await processor.prepare(input)).not.toBeNull();
    enabled = false;
    expect(await processor.prepare(input)).toBeNull();
    enabled = true;
    controller.abort();
    expect(await processor.prepare(input)).toBeNull();
  });
  it('tighten only returns a candidate meeting the exact byte limit', async () => {
    const processor = createInlineImagePreprocessor();
    const input = { bytes: await source(), mimeType: 'image/png', route: {}, signal: new AbortController().signal };
    const result = await processor.tighten!({ ...input, maxBytes: 1500 });
    expect(result).not.toBeNull();
    expect(result!.bytes.length).toBeLessThanOrEqual(1500);
    expect(await processor.tighten!({ ...input, maxBytes: 1 })).toBeNull();
  });
});

// PR 2 performance contract: abort must not release a still-running encoder slot.
it('caps encoding at two jobs even when a running caller aborts', async () => {
  const releases: Array<() => void> = [];
  const encode = vi.fn(async request => {
    await new Promise<void>(resolve => releases.push(resolve));
    return { bytes: request.bytes, mimeType: request.mimeType, width: 1, height: 1, changed: false, cacheKey: 'test' };
  });
  const processor = createInlineImagePreprocessor(() => true, encode);
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const jobs = controllers.map((controller, i) => processor.prepare({ bytes: Buffer.from([i]), mimeType: 'image/png', route: {}, signal: controller.signal }));
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(2));
  controllers[0].abort();
  expect(await jobs[0]).toBeNull();
  expect(encode).toHaveBeenCalledTimes(2);
  releases[0]();
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(3));
  releases[1]();
  releases[2]();
  await Promise.all(jobs);
});

// Unit regression: resizer and proxy used separate provenance registries, causing
// two lossy JPEG encodes. Real resizer output must bypass the proxy encoder.
it('does not encode a JPEG again after the user-attachment resizer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-resizer-proxy-'));
  try {
    const sourcePath = path.join(root, 'source.jpg');
    const source = await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    expect(source.length).toBeGreaterThan(500_000);
    await fs.writeFile(sourcePath, source);
    const resizer = new ImageResizer({ cacheDir: path.join(root, 'cache') });
    const resizedPath = await resizer.process(sourcePath);
    expect(resizedPath).not.toBe(sourcePath);
    const bytes = await fs.readFile(resizedPath);
    expect((await sharp(bytes).metadata()).format).toBe('jpeg');
    const encode = vi.fn(compressImageBuffer);
    const processor = createInlineImagePreprocessor(() => true, encode);
    expect(await processor.prepare({ bytes, mimeType: 'image/jpeg', route: { providerId: 'openai', modelId: 'gpt-6-astra' }, signal: new AbortController().signal })).toBeNull();
    expect(encode).not.toHaveBeenCalled();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('reads the XDT disable override on every call without clearing other settings', async () => {
  const original = process.env.XDT_IMAGE_COMPRESSION_DISABLE;
  const encode = vi.fn(compressImageBuffer);
  const processor = createInlineImagePreprocessor(undefined, encode);
  const input = { bytes: Buffer.from('invalid-image'), mimeType: 'image/png', route: {}, signal: new AbortController().signal };
  try {
    process.env.XDT_IMAGE_COMPRESSION_DISABLE = '1';
    expect(await processor.prepare(input)).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    delete process.env.XDT_IMAGE_COMPRESSION_DISABLE;
    await processor.prepare(input);
    expect(encode).toHaveBeenCalledOnce();
  } finally {
    if (original === undefined) delete process.env.XDT_IMAGE_COMPRESSION_DISABLE;
    else process.env.XDT_IMAGE_COMPRESSION_DISABLE = original;
  }
});

it('bypasses encoding while disabled and reuses the result after reenabling', async () => {
  let enabled = true;
  const encode = vi.fn(compressImageBuffer);
  const processor = createInlineImagePreprocessor(() => enabled, encode);
  const bytes = await sharp({ create: { width: 150, height: 80, channels: 3, background: '#135724' } }).png({ compressionLevel: 0 }).toBuffer();
  const input = { bytes, mimeType: 'image/png', route: { providerId: 'openai', modelId: 'gpt-6-astra' }, signal: new AbortController().signal };
  const first = await processor.prepare(input);
  expect(first?.changed).toBe(true);
  expect(encode).toHaveBeenCalledOnce();
  enabled = false;
  expect(await processor.prepare(input)).toBeNull();
  expect(encode).toHaveBeenCalledOnce();
  enabled = true;
  expect(await processor.prepare(input)).toBe(first);
  expect(encode).toHaveBeenCalledOnce();
});

// Unit: user decision to keep JPEG byte-for-byte in prepare. Existing provenance
// coverage only checked resizer outputs, not untouched q95/q85 or EXIF sources.
it.each([{ quality: 95 }, { quality: 85 }, { quality: 95, orientation: 6 }])(
  'preserves JPEG $quality / $orientation before encoding, but still tightens originals',
  async ({ quality, orientation }) => {
    const bytes = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#517293' } })
      .withMetadata({ orientation }).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
    const encode = vi.fn(compressImageBuffer);
    const processor = createInlineImagePreprocessor(() => true, encode);
    const input = { bytes, mimeType: 'image/jpeg', route: { providerId: 'openai' }, signal: new AbortController().signal };
    const result = await processor.prepare(input);
    expect(result).toBeNull();
    expect(result?.bytes ?? bytes).toEqual(bytes);
    expect(encode).not.toHaveBeenCalled();
    const maxBytes = Math.floor(bytes.length * 0.7);
    const tight = await processor.tighten!({ ...input, maxBytes });
    expect(tight?.mimeType).toBe('image/jpeg');
    expect(tight!.bytes.length).toBeLessThanOrEqual(maxBytes);
    expect(encode.mock.calls[0][0].bytes).toEqual(bytes);
    if (orientation === 6) {
      const meta = await sharp(tight!.bytes).metadata();
      expect([meta.width, meta.height]).toEqual([96, 128]);
      expect(meta.orientation).toBeUndefined();
    }
  },
);
