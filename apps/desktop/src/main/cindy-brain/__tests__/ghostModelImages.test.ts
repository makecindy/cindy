import { describe, it, expect, vi } from 'vitest';

import {
  GHOST_MODEL_IMAGE_MAX_COUNT,
  fitGhostModelImages,
  normalizeGhostModelImages,
} from '../ghostModelImages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgYGD4D8UQBgAd9AP9JAD7OgAAAABJRU5ErkJggg==', 'base64');

describe('normalizeGhostModelImages', () => {
  it('keeps PNG and JPEG with the format sniffed from the bytes, not the claimed type', () => {
    const { images, dropped } = normalizeGhostModelImages([{ data: PNG, mimeType: 'image/jpeg' }, { data: JPEG }]);
    expect(images.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(dropped).toBe(0);
  });

  it('drops SVG, text, malformed base64, non-objects and anything past the limit', () => {
    const many = Array.from({ length: GHOST_MODEL_IMAGE_MAX_COUNT + 1 }, () => ({ data: PNG }));
    expect(normalizeGhostModelImages(many).images).toHaveLength(GHOST_MODEL_IMAGE_MAX_COUNT);
    expect(normalizeGhostModelImages(many).dropped).toBe(1);
    expect(normalizeGhostModelImages([{ data: SVG }, { data: 'not base64!' }, { data: '' }, null, 'x']).images).toEqual([]);
    expect(normalizeGhostModelImages({ data: PNG })).toEqual({ images: [], dropped: 1 });
    expect(normalizeGhostModelImages(undefined)).toEqual({ images: [], dropped: 0 });
  });
});

describe('fitGhostModelImages', () => {
  // 小于预算的损坏图片也不能进入模型请求；此前只有文件头便被原样返回。
  it('omits a truncated PNG even when it fits the budget', async () => {
    expect(await fitGhostModelImages([{ data: PNG, mimeType: 'image/png' }], vi.fn()))
      .toEqual({ images: [], omitted: 1 });
  });
  it('passes small images through untouched and shares the budget between images', async () => {
    const compress = vi.fn();
    const small = { data: VALID_PNG.toString('base64'), mimeType: 'image/png' };
    expect(await fitGhostModelImages([small], compress, 1000)).toEqual({ images: [small], omitted: 0 });
    expect(compress).not.toHaveBeenCalled();
    const big = { data: Buffer.concat([VALID_PNG, Buffer.alloc(800)]).toString('base64'), mimeType: 'image/png' };
    compress.mockResolvedValue({ buffer: Buffer.alloc(400), mime: 'image/webp' });
    const fitted = await fitGhostModelImages([small, big], compress, 1000);
    expect(compress).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { targetBytes: 500 });
    expect(fitted.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/webp']);
  });

  it('leaves out an image that cannot be made small enough, and counts it', async () => {
    const big = { data: Buffer.concat([VALID_PNG, Buffer.alloc(2000)]).toString('base64'), mimeType: 'image/png' };
    expect(await fitGhostModelImages([big], vi.fn().mockResolvedValue(null), 1000)).toEqual({ images: [], omitted: 1 });
    expect(await fitGhostModelImages([big], vi.fn().mockResolvedValue({ buffer: Buffer.alloc(1500), mime: 'image/webp' }), 1000))
      .toEqual({ images: [], omitted: 1 });
  });
});
