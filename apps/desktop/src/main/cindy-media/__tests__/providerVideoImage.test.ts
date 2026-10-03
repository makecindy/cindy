import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { validateProviderVideoImage } from '../providerVideoImage.js';

describe('strict subscription-video reference decoder', () => {
  let png: Buffer;
  let progressiveJpeg: Buffer;
  const uri = (bytes: Buffer, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
  beforeAll(async () => {
    // Find a tiny valid PNG with padding, so noncanonical pad bits can be tested independently.
    for (let width = 1; width < 20; width++) {
      png = await sharp({ create: { width, height: 2, channels: 4, background: '#4499bb66' } }).png().toBuffer();
      if (png.length % 3 !== 0) break;
    }
    progressiveJpeg = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#dd3355' } })
      .jpeg({ progressive: true }).toBuffer();
  });
  it('accepts alpha PNG and progressive JPEG without rewriting input bytes', async () => {
    for (const value of [uri(png), uri(progressiveJpeg, 'image/jpeg')]) {
      expect(await validateProviderVideoImage(value) === value).toBe(true);
    }
  });
  it('rejects non-zero base64 padding bits even when permissive decoding yields identical image bytes', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const encoded = png.toString('base64'), padding = encoded.endsWith('==') ? 2 : 1;
    expect(encoded.endsWith('=')).toBe(true);
    const at = encoded.length - padding - 1;
    const bad = encoded.slice(0, at) + alphabet[alphabet.indexOf(encoded[at]) + 1] + encoded.slice(at + 1);
    expect(Buffer.from(bad, 'base64').equals(png)).toBe(true);
    await expect(validateProviderVideoImage('data:image/png;base64,' + bad)).rejects.toMatchObject({ code: 'MEDIA_INPUT_INVALID' });
  });
  it('rejects trailing bytes after the actual PNG/JPEG terminator', async () => {
    for (const [bytes, mime] of [[png, 'image/png'], [progressiveJpeg, 'image/jpeg']] as const) {
      await expect(validateProviderVideoImage(uri(Buffer.concat([bytes, bytes]), mime))).rejects.toMatchObject({ code: 'MEDIA_INPUT_INVALID' });
    }
  });
  it('bounds decoder concurrency and releases slots after completion', async () => {
    const value = uri(png);
    const results = await Promise.allSettled([validateProviderVideoImage(value), validateProviderVideoImage(value), validateProviderVideoImage(value)]);
    expect(results.slice(0, 2).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(results[2].status === 'rejected' && results[2].reason.code === 'MEDIA_INPUT_BUSY').toBe(true);
    expect(await validateProviderVideoImage(value) === value).toBe(true);
  });
});
