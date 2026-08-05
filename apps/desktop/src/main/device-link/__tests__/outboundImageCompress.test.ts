/**
 * outboundImageCompress.test.ts — 出方向图片压缩的策略与守卫:
 * 格式分派 / skip 规则 / 防膨胀 / 失败回退。变换经 deps 注入,不触碰 sharp。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  OUTBOUND_IMAGE_JPEG_QUALITY,
  OUTBOUND_IMAGE_MAX_EDGE,
  OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES,
  compressOutboundImage,
  planOutboundImageCompression,
  type OutboundImageTransform,
} from '../outboundImageCompress';

describe('planOutboundImageCompression', () => {
  it('png 只降采样(skipWithoutResize),jpeg 按体积决定是否必重编码', () => {
    expect(planOutboundImageCompression('image/png', 10 * 1024 * 1024))
      .toEqual({ format: 'png', skipWithoutResize: true });
    expect(planOutboundImageCompression('image/jpeg', OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES + 1))
      .toEqual({ format: 'jpeg', skipWithoutResize: false });
    expect(planOutboundImageCompression('image/jpeg', OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES))
      .toEqual({ format: 'jpeg', skipWithoutResize: true });
  });

  it('gif / webp / 非图片 / 未知 mime 直通不压', () => {
    expect(planOutboundImageCompression('image/gif', 100)).toBeNull();
    expect(planOutboundImageCompression('image/webp', 100)).toBeNull();
    expect(planOutboundImageCompression('application/pdf', 100)).toBeNull();
    expect(planOutboundImageCompression(undefined, 100)).toBeNull();
  });
});

describe('compressOutboundImage', () => {
  const bigJpeg = Buffer.alloc(OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES + 1, 7);

  it('直通格式不调 transform', async () => {
    const transform = vi.fn<OutboundImageTransform>();
    expect(await compressOutboundImage(Buffer.from([1]), 'image/gif', { transform })).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it('按 plan 组装 transform 入参,产物更小则采纳', async () => {
    const out = Buffer.alloc(100 * 1024, 1);
    const transform = vi.fn<OutboundImageTransform>().mockResolvedValue(out);
    const result = await compressOutboundImage(bigJpeg, 'image/jpeg', { transform });
    expect(transform).toHaveBeenCalledTimes(1);
    // Avoid deep-equality walking the 2 MiB input buffer under the full desktop
    // test suite; verify the buffer identity separately and keep the remaining
    // transform options covered by a small object comparison.
    expect(transform).toHaveBeenCalledTimes(1);
    const transformInput = transform.mock.calls[0]?.[0];
    expect(transformInput?.bytes).toBe(bigJpeg);
    expect(transformInput).toMatchObject({
      maxEdge: OUTBOUND_IMAGE_MAX_EDGE,
      format: 'jpeg',
      quality: OUTBOUND_IMAGE_JPEG_QUALITY,
      skipWithoutResize: false,
    });
    expect(result?.bytes).toBe(out);
    expect(result).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg' });
  }, 15_000);

  it('png 产物保持 png 类型标注', async () => {
    const out = Buffer.alloc(10, 1);
    const result = await compressOutboundImage(Buffer.alloc(100, 2), 'image/png', {
      transform: vi.fn<OutboundImageTransform>().mockResolvedValue(out),
    });
    expect(result).toEqual({ bytes: out, contentType: 'image/png', ext: 'png' });
  });

  it('transform 放弃(skip 规则)/ 产物不更小 / 抛错 → 一律回退原字节(null)', async () => {
    expect(await compressOutboundImage(bigJpeg, 'image/jpeg', {
      transform: vi.fn<OutboundImageTransform>().mockResolvedValue(null),
    })).toBeNull();
    expect(await compressOutboundImage(bigJpeg, 'image/jpeg', {
      transform: vi.fn<OutboundImageTransform>().mockResolvedValue(Buffer.alloc(bigJpeg.byteLength, 1)),
    })).toBeNull();
    expect(await compressOutboundImage(bigJpeg, 'image/jpeg', {
      transform: vi.fn<OutboundImageTransform>().mockRejectedValue(new Error('sharp boom')),
    })).toBeNull();
  });
});

describe('mayCompressOutboundImage', () => {
  it('png/jpeg 可能压,gif/webp/未知 mime 恒直通(调用方据此决定是否读盘)', async () => {
    const { mayCompressOutboundImage } = await import('../outboundImageCompress');
    expect(mayCompressOutboundImage('image/png')).toBe(true);
    expect(mayCompressOutboundImage('image/jpeg')).toBe(true);
    expect(mayCompressOutboundImage('image/gif')).toBe(false);
    expect(mayCompressOutboundImage('image/webp')).toBe(false);
    expect(mayCompressOutboundImage(undefined)).toBe(false);
  });
});
