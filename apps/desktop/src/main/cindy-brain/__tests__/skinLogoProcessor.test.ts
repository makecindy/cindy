import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { whiteBackgroundToTransparentPng } from '../skinLogoProcessor';

describe('whiteBackgroundToTransparentPng', () => {
  it('removes a white canvas, preserves dark lettering, and trims empty margins', async () => {
    const source = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 40,
              height: 12,
              channels: 4,
              background: { r: 20, g: 60, b: 120, alpha: 1 },
            },
          },
          left: 20,
          top: 14,
        },
      ])
      .png()
      .toBuffer();

    const output = await whiteBackgroundToTransparentPng(source);
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    expect(info.width).toBe(40);
    expect(info.height).toBe(12);
    expect(data[3]).toBe(255);
  });

  it('rejects an empty white image', async () => {
    const source = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await expect(whiteBackgroundToTransparentPng(source)).rejects.toThrow(
      'Logo 去白底后没有可见内容',
    );
  });

  it('rejects a processed PNG that exceeds the skin image byte limit', async () => {
    const width = 2_000;
    const height = 2_000;
    const pixels = Buffer.allocUnsafe(width * height * 3);
    let state = 0x12345678;
    for (let offset = 0; offset < pixels.length; offset += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[offset] = state & 0x7f;
    }
    const source = await sharp(pixels, {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    expect(source.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    await expect(whiteBackgroundToTransparentPng(source)).rejects.toThrow(
      'Logo 去白底后的 PNG 超过 8 MB',
    );
  });
});
