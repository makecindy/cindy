// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { avatarCropDrawRect, avatarOutputSize, type AvatarCrop } from '../avatarCropGeometry';
import {
  AVATAR_SOURCE_MAX_EDGE,
  avatarExportMime,
  exportAvatarCrop,
  fitAvatarSourceSize,
  hasTransparentPixel,
  loadAvatarSource,
  type AvatarSource,
} from '../avatarCropImage';

function makeSource(width: number, height: number): AvatarSource {
  return {
    bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap,
    size: { width, height },
  };
}

const DATA_URL = 'data:image/jpeg;base64,AAAA';

/**
 * 替身:`<img>` 只报告(已转正的)尺寸、不解码像素;createImageBitmap 按传入的
 * resize 选项产出对应尺寸的位图并记录调用,用来断言解码次数与目标尺寸。
 */
function stubDecoder(natural: { width: number; height: number } | 'error') {
  URL.createObjectURL = vi.fn(() => 'blob:avatar-probe');
  URL.revokeObjectURL = vi.fn();
  class FakeImage {
    naturalWidth = natural === 'error' ? 0 : natural.width;
    naturalHeight = natural === 'error' ? 0 : natural.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => (natural === 'error' ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
  const created: ImageBitmap[] = [];
  const createImageBitmapMock = vi.fn(async (_source: unknown, options?: ImageBitmapOptions) => {
    const size = natural === 'error' ? { width: 0, height: 0 } : natural;
    const bitmap = {
      width: options?.resizeWidth ?? size.width,
      height: options?.resizeHeight ?? size.height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    created.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  return { createImageBitmapMock, created };
}

/** 记录 drawImage 调用的最小 2D context 替身,getImageData 返回指定 alpha。 */
function stubCanvas(alpha: number) {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    data[3] = alpha;
    return { data };
  });
  const ctx = {
    drawImage,
    getImageData,
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as RenderingContext,
  );
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
  ) {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type }));
  });
  return { ctx, drawImage, getImageData, toBlob };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('avatarCropImage', () => {
  it('超大源图按长边等比缩到上限,小图原样保留', () => {
    expect(fitAvatarSourceSize({ width: 8000, height: 6000 })).toEqual({
      width: AVATAR_SOURCE_MAX_EDGE,
      height: 3072,
    });
    expect(fitAvatarSourceSize({ width: 3000, height: 9000 })).toEqual({
      width: 1365,
      height: AVATAR_SOURCE_MAX_EDGE,
    });
    const small = { width: 640, height: 480 };
    expect(fitAvatarSourceSize(small)).toBe(small);
  });

  it('透明判定:任一像素 alpha < 255 即视为透明', () => {
    expect(hasTransparentPixel(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparentPixel(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
  });

  it('导出格式只看导出像素:有透明像素才导出 PNG,与文件扩展名无关', () => {
    expect(avatarExportMime(new Uint8ClampedArray([0, 0, 0, 255]))).toBe('image/jpeg');
    expect(avatarExportMime(new Uint8ClampedArray([0, 0, 0, 0]))).toBe('image/png');
  });

  it('超大原片只解码一次,直接解到长边上限(不先留一张全尺寸位图)', async () => {
    const { createImageBitmapMock, created } = stubDecoder({ width: 8000, height: 6000 });
    const source = await loadAvatarSource(DATA_URL);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock.mock.calls[0]?.[1]).toEqual({
      imageOrientation: 'from-image',
      resizeWidth: AVATAR_SOURCE_MAX_EDGE,
      resizeHeight: 3072,
      resizeQuality: 'high',
    });
    expect(source.size).toEqual({ width: AVATAR_SOURCE_MAX_EDGE, height: 3072 });
    expect(source.bitmap).toBe(created[0]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-probe');
  });

  it('普通尺寸按原尺寸解码并转正;无法解码或零尺寸时不创建位图', async () => {
    const small = stubDecoder({ width: 1200, height: 2000 });
    const source = await loadAvatarSource(DATA_URL);
    expect(small.createImageBitmapMock.mock.calls[0]?.[1]).toEqual({
      imageOrientation: 'from-image',
    });
    expect(source.size).toEqual({ width: 1200, height: 2000 });

    const broken = stubDecoder('error');
    await expect(loadAvatarSource(DATA_URL)).rejects.toThrow();
    expect(broken.createImageBitmapMock).not.toHaveBeenCalled();

    const empty = stubDecoder({ width: 0, height: 0 });
    await expect(loadAvatarSource(DATA_URL)).rejects.toThrow();
    expect(empty.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('导出把取景源矩形原样画进正方形输出画布(与编辑台同一映射,无二次裁剪 / 拉伸)', async () => {
    const { drawImage, getImageData, toBlob } = stubCanvas(255);
    const source = makeSource(4000, 3000);
    const crop: AvatarCrop = { cx: 1700.5, cy: 1400.25, side: 1200 };

    const result = await exportAvatarCrop(source, crop);

    const out = avatarOutputSize(crop);
    const { sx, sy, sw, sh } = avatarCropDrawRect(crop);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(source.bitmap, sx, sy, sw, sh, 0, 0, out, out);
    // 透明判定读的是导出画布本身。
    expect(getImageData).toHaveBeenCalledWith(0, 0, out, out);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect(result.mimeType).toBe('image/jpeg');
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it('导出画布有透明像素时导出 PNG,保留透明(含扩展名写错的透明图)', async () => {
    const { toBlob } = stubCanvas(0);
    const result = await exportAvatarCrop(makeSource(800, 800), {
      cx: 400,
      cy: 400,
      side: 800,
    });
    expect(result.mimeType).toBe('image/png');
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });
});
