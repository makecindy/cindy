import { Buffer } from 'node:buffer';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { desktopAnthropicImageCodec } from '../anthropic-image-codec.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('desktopAnthropicImageCodec', () => {
  it('passes through a small valid PNG without changing its bytes or media type', async () => {
    await expect(desktopAnthropicImageCodec.normalize({
      data: TINY_PNG,
      mediaType: 'image/png',
      maxEdge: 2000,
      qualities: [80],
      hardCap: 2 * 1024 * 1024,
    })).resolves.toEqual({ data: TINY_PNG, mediaType: 'image/png' });
  });

  it('uses the decoded image format instead of an untrusted declared media type', async () => {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: '#336699',
      },
    }).jpeg().toBuffer();
    const data = jpeg.toString('base64');

    await expect(desktopAnthropicImageCodec.normalize({
      data,
      mediaType: 'image/png',
      maxEdge: 2000,
      qualities: [80],
      hardCap: 2 * 1024 * 1024,
    })).resolves.toEqual({ data, mediaType: 'image/jpeg' });
  });

  it('rejects malformed base64 before decoding', async () => {
    await expect(desktopAnthropicImageCodec.normalize({
      data: 'not*base64',
      mediaType: 'image/png',
      maxEdge: 2000,
      qualities: [80],
      hardCap: 2 * 1024 * 1024,
    })).resolves.toBeNull();
  });

  it('resizes an oversized image and re-encodes it as JPEG', async () => {
    const input = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: '#336699',
      },
    }).png().toBuffer();
    const output = await desktopAnthropicImageCodec.normalize({
      data: input.toString('base64'),
      mediaType: 'image/png',
      maxEdge: 1024,
      qualities: [70, 50],
      hardCap: 512 * 1024,
    });
    expect(output?.mediaType).toBe('image/jpeg');
    const metadata = await sharp(Buffer.from(output!.data, 'base64')).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1024);
  });

  it('rejects image inputs above the decoded pixel safety limit', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10001" height="10001"><rect width="100%" height="100%"/></svg>';
    await expect(desktopAnthropicImageCodec.normalize({
      data: Buffer.from(svg).toString('base64'),
      mediaType: 'image/svg+xml',
      maxEdge: 2000,
      qualities: [80],
      hardCap: 2 * 1024 * 1024,
    })).resolves.toBeNull();
  });
});
