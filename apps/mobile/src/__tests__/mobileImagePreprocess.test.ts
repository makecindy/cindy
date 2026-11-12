import { describe, expect, it, vi } from 'vitest';
import {
  MOBILE_IMAGE_PREPROCESS_MAX_BYTES,
  MOBILE_IMAGE_UPLOAD_JPEG_QUALITY,
  MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE,
  MOBILE_IMAGE_UPLOAD_SKIP_BYTES,
  planMobileImageUploadPreprocess,
  preprocessMobileImageForUpload,
  renameForMobileImagePreprocess,
} from '@/session/mobileImagePreprocess';

const BIG = MOBILE_IMAGE_UPLOAD_SKIP_BYTES + 1;
const SMALL = MOBILE_IMAGE_UPLOAD_SKIP_BYTES - 1;
const LONG = MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE;

describe('planMobileImageUploadPreprocess', () => {
  it('gif 一律跳过(重编码会毁动画)', () => {
    expect(planMobileImageUploadPreprocess({
      mimeType: 'image/gif', size: 10_000_000, width: 4000, height: 3000,
    })).toBeNull();
  });

  it('超大文件不在手机上解码,原样上传(避免整图解码占满内存)', () => {
    for (const mimeType of ['image/jpeg', 'image/png']) {
      expect(planMobileImageUploadPreprocess({
        mimeType, size: MOBILE_IMAGE_PREPROCESS_MAX_BYTES + 1, width: 12000, height: 9000,
      })).toBeNull();
    }
    expect(planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: MOBILE_IMAGE_PREPROCESS_MAX_BYTES, width: 12000, height: 9000,
    })).not.toBeNull();
  });

  it('小尺寸小体积 jpeg 原样上传', () => {
    expect(planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: SMALL, width: 1200, height: 900,
    })).toBeNull();
  });

  it('大体积 jpeg 长边超限时缩到上限并压 0.8', () => {
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: 8_000_000, width: 4032, height: 3024,
    });
    expect(plan).toEqual({
      resize: { width: LONG },
      format: 'jpeg',
      compress: MOBILE_IMAGE_UPLOAD_JPEG_QUALITY,
    });
  });

  it('竖图按 height 缩长边', () => {
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: 8_000_000, width: 3024, height: 4032,
    });
    expect(plan?.resize).toEqual({ height: LONG });
  });

  it('大体积但尺寸未知的 jpeg 只重编码不缩尺寸(避免放大)', () => {
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: BIG, width: null, height: null,
    });
    expect(plan).toEqual({ resize: null, format: 'jpeg', compress: MOBILE_IMAGE_UPLOAD_JPEG_QUALITY });
  });

  it('尺寸超限但体积小的 jpeg 仍缩尺寸', () => {
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/jpeg', size: SMALL, width: LONG + 1000, height: 1000,
    });
    expect(plan?.resize).toEqual({ width: LONG });
  });

  it('png 只在超尺寸时处理并保持 png(不毁透明)', () => {
    expect(planMobileImageUploadPreprocess({
      mimeType: 'image/png', size: 9_000_000, width: 2000, height: 1500,
    })).toBeNull();
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/png', size: 9_000_000, width: 1179, height: 2556,
    });
    expect(plan).toEqual({ resize: { height: LONG }, format: 'png', compress: 1 });
  });

  it('webp 与 png 同待遇:只在超尺寸时缩边并输出 png,绝不进 JPEG 分支拍平透明', () => {
    // 大体积但不超尺寸:不重编码(JPEG 会把透明 webp 的 alpha 拍平成黑/白底)。
    expect(planMobileImageUploadPreprocess({
      mimeType: 'image/webp', size: BIG, width: 2000, height: 1500,
    })).toBeNull();
    const plan = planMobileImageUploadPreprocess({
      mimeType: 'image/webp', size: BIG, width: 3000, height: 2000,
    });
    expect(plan).toEqual({ resize: { width: LONG }, format: 'png', compress: 1 });
  });

  it('mimeType 缺失时按 jpeg 处理', () => {
    const plan = planMobileImageUploadPreprocess({
      size: BIG, width: 4000, height: 3000,
    });
    expect(plan?.format).toBe('jpeg');
  });
});

describe('renameForMobileImagePreprocess', () => {
  it('替换扩展名并保留主名', () => {
    expect(renameForMobileImagePreprocess('IMG_0001.HEIC', 'jpeg')).toBe('IMG_0001.jpg');
    expect(renameForMobileImagePreprocess('shot.png', 'png')).toBe('shot.png');
    expect(renameForMobileImagePreprocess('noext', 'jpeg')).toBe('noext.jpg');
  });
});

describe('preprocessMobileImageForUpload', () => {
  const bigJpeg = {
    uri: 'file:///tmp/a.jpg',
    name: 'a.jpg',
    mimeType: 'image/jpeg',
    size: 8_000_000,
    width: 4032,
    height: 3024,
  };

  it('plan 为 null 时不调 manipulator,原样返回', async () => {
    const run = vi.fn();
    const out = await preprocessMobileImageForUpload({
      uri: 'file:///tmp/s.jpg', name: 's.jpg', mimeType: 'image/jpeg', size: SMALL, width: 800, height: 600,
    }, { run, statSize: vi.fn() });
    expect(out.uri).toBe('file:///tmp/s.jpg');
    expect(run).not.toHaveBeenCalled();
  });

  it('处理成功时返回新 uri / 新 size / 重命名后的文件名', async () => {
    const out = await preprocessMobileImageForUpload(bigJpeg, {
      run: vi.fn().mockResolvedValue({ uri: 'file:///tmp/a-resized.jpg' }),
      statSize: vi.fn().mockResolvedValue(500_000),
    });
    expect(out).toEqual({
      uri: 'file:///tmp/a-resized.jpg',
      name: 'a.jpg',
      mimeType: 'image/jpeg',
      size: 500_000,
    });
  });

  it('manipulator 抛错时回退原图(压缩失败不能挡发图)', async () => {
    const out = await preprocessMobileImageForUpload(bigJpeg, {
      run: vi.fn().mockRejectedValue(new Error('native boom')),
      statSize: vi.fn(),
    });
    expect(out.uri).toBe(bigJpeg.uri);
    expect(out.size).toBe(bigJpeg.size);
  });

  it('产物没有变小时回退原图', async () => {
    const out = await preprocessMobileImageForUpload(bigJpeg, {
      run: vi.fn().mockResolvedValue({ uri: 'file:///tmp/a-bloated.jpg' }),
      statSize: vi.fn().mockResolvedValue(bigJpeg.size + 1),
    });
    expect(out.uri).toBe(bigJpeg.uri);
  });

  it('产物 stat 不到大小时回退原图', async () => {
    const out = await preprocessMobileImageForUpload(bigJpeg, {
      run: vi.fn().mockResolvedValue({ uri: 'file:///tmp/a-resized.jpg' }),
      statSize: vi.fn().mockResolvedValue(0),
    });
    expect(out.uri).toBe(bigJpeg.uri);
  });
});
