// @vitest-environment jsdom
/**
 * materializeAnnotatedAttachmentsForSend — 发送前标注物化的直接单测。
 *
 * 覆盖:烧录成功的产物形态(原图引用、笔迹、标注区域、文件名)、幂等(已烧录
 * 附件原样返回)、remote 剥离元数据、烧录失败的两种处理(降级 + 通知 / 中止抛错)、
 * 共享引用附件的私有化。canvas 与图片解码在 jsdom 中不可用,这里只替换这两个
 * 浏览器原语,materialize 本身的逻辑全部真实执行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AnnotationBurnInError,
  annotatedFileName,
  isAnnotationBurnInError,
  materializeAnnotatedAttachmentsForSend,
} from '@/lib/annotationBurnIn';
import type { AttachedFile } from '@/lib/fileTypes';

const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];

function imageFile(overrides: Partial<AttachedFile> = {}): AttachedFile {
  return {
    id: 'img-1',
    name: 'shot.png',
    originalName: 'shot.png',
    path: '/Users/sam/shot.png',
    ext: '.png',
    size: 10,
    category: 'image',
    mimeType: 'image/png',
    url: 'cindy-media://blobs/source.png',
    ...overrides,
  };
}

const api = {
  readCachedImageAsBase64: vi.fn(),
  cacheImageFromBuffer: vi.fn(),
  cacheMediaForSession: vi.fn(),
  cleanupCachedImages: vi.fn(),
};

beforeEach(() => {
  api.cleanupCachedImages.mockResolvedValue(undefined);
  api.readCachedImageAsBase64.mockResolvedValue({ base64: 'AAAA', mimeType: 'image/png' });
  api.cacheImageFromBuffer.mockResolvedValue({
    url: 'cindy-media://blobs/burned.png',
    filename: 'burned.png',
  });
  api.cacheMediaForSession.mockResolvedValue({
    url: 'cindy-media://blobs/private.png',
    name: 'private.png',
    ext: '.png',
    mimeType: 'image/png',
    size: 99,
  });
  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  // jsdom 未实现 HTMLImageElement.decode:按浏览器语义补一个立即 resolve 的版本。
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: () => Promise.resolve(),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(
    callback: BlobCallback,
    type?: string,
  ) {
    callback(new Blob(['burned-bytes'], { type: type ?? 'image/png' }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
});

describe('materializeAnnotatedAttachmentsForSend', () => {
  it('returns a plain copy without any IPC when nothing needs burning', async () => {
    const files = [imageFile()];
    const result = await materializeAnnotatedAttachmentsForSend(files, 's1');
    expect(result).toEqual(files);
    expect(result).not.toBe(files);
    expect(api.readCachedImageAsBase64).not.toHaveBeenCalled();
    await expect(materializeAnnotatedAttachmentsForSend(undefined, 's1')).resolves.toBeUndefined();
  });

  it('burns strokes into a new cached bitmap and keeps the editable source + regions', async () => {
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [imageFile({ annotationStrokes: strokes })],
        's1',
      )) ?? [];

    expect(api.readCachedImageAsBase64).toHaveBeenCalledWith({
      url: 'cindy-media://blobs/source.png',
    });
    expect(api.cacheImageFromBuffer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      url: 'cindy-media://blobs/burned.png',
      name: 'shot-annotated.png',
      originalName: 'shot-annotated.png',
      ext: '.png',
      mimeType: 'image/png',
      annotated: true,
      annotationSourceUrl: 'cindy-media://blobs/source.png',
      annotationStrokes: strokes,
      annotationRegions: [{ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 }],
    });
    // 原图磁盘路径不变(队列 / 历史仍以 url 为准)。
    expect(result.path).toBe('/Users/sam/shot.png');
  });

  it('burns new strokes onto a base-annotated image without describing regions', async () => {
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [imageFile({ annotationStrokes: strokes, baseAnnotated: true })],
        's1',
      )) ?? [];
    expect(result).toMatchObject({ annotated: true, baseAnnotated: true });
    // 旧红线位置不可知:只描述新笔迹会与图上红线不符,故不带区域。
    expect(result.annotationRegions).toBeUndefined();
  });

  it('is idempotent for already-burned attachments (auth-retry resend)', async () => {
    const burned = imageFile({
      url: 'cindy-media://blobs/burned.png',
      annotated: true,
      annotationSourceUrl: 'cindy-media://blobs/source.png',
      annotationStrokes: strokes,
    });
    const [result] = (await materializeAnnotatedAttachmentsForSend([burned], 's1')) ?? [];
    expect(result).toBe(burned);
    expect(api.readCachedImageAsBase64).not.toHaveBeenCalled();
    expect(api.cacheImageFromBuffer).not.toHaveBeenCalled();
  });

  it('strips controller-local annotation meta for remote sessions but keeps regions', async () => {
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [imageFile({ annotationStrokes: strokes })],
        's1',
        { stripAnnotationMeta: true },
      )) ?? [];
    expect(result.annotated).toBe(true);
    expect(result.annotationSourceUrl).toBeUndefined();
    expect(result.annotationStrokes).toBeUndefined();
    expect(result.annotationRegions).toEqual([{ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 }]);
  });

  it('burns base64 draft attachments in place', async () => {
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [imageFile({ url: undefined, base64: 'QUJD', annotationStrokes: strokes })],
        's1',
      )) ?? [];
    expect(api.cacheImageFromBuffer).not.toHaveBeenCalled();
    expect(result.annotated).toBe(true);
    expect(result.base64).toBeTruthy();
    expect(result.base64).not.toBe('QUJD');
    expect(result.annotationRegions).toHaveLength(1);
  });

  it('falls back to the original image and notifies once when burning fails (default)', async () => {
    api.readCachedImageAsBase64.mockRejectedValue(new Error('gone'));
    const onFallback = vi.fn();
    const files = [
      imageFile({ id: 'a', annotationStrokes: strokes }),
      imageFile({ id: 'b', annotationStrokes: strokes }),
    ];
    const result = (await materializeAnnotatedAttachmentsForSend(files, 's1', { onFallback })) ?? [];

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(2);
    for (const file of result) {
      expect(file.url).toBe('cindy-media://blobs/source.png');
      expect(file.annotated).toBeUndefined();
      expect(file.annotationStrokes).toBeUndefined();
      expect(file.annotationSourceUrl).toBeUndefined();
      expect(file.annotationRegions).toBeUndefined();
    }
  });

  it('aborts with AnnotationBurnInError in abort mode and never notifies a fallback', async () => {
    api.readCachedImageAsBase64.mockRejectedValue(new Error('gone'));
    const onFallback = vi.fn();
    const promise = materializeAnnotatedAttachmentsForSend(
      [imageFile({ annotationStrokes: strokes })],
      's1',
      { burnFailure: 'abort', onFallback },
    );
    await expect(promise).rejects.toBeInstanceOf(AnnotationBurnInError);
    await promise.catch((error) => expect(isAnnotationBurnInError(error)).toBe(true));
    expect(onFallback).not.toHaveBeenCalled();
    expect(api.cacheImageFromBuffer).not.toHaveBeenCalled();
  });

  it('abort mode burns the whole batch first: no cache writes or private copies if any burn fails', async () => {
    api.readCachedImageAsBase64.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes('broken')) throw new Error('decode failed');
      return { base64: 'AAAA', mimeType: 'image/png' };
    });
    const files = [
      imageFile({ id: 'ok', annotationStrokes: strokes }),
      imageFile({ id: 'bad', url: 'cindy-media://blobs/broken.png', annotationStrokes: strokes }),
      imageFile({ id: 'shared', url: 'cindy-media://blobs/history.png', cacheUrlShared: true }),
    ];

    await expect(
      materializeAnnotatedAttachmentsForSend(files, 's1', { burnFailure: 'abort' }),
    ).rejects.toBeInstanceOf(AnnotationBurnInError);
    // 失败图片之外的图也已烧完(allSettled),但整批中止前不写媒体仓、不私有化。
    expect(api.readCachedImageAsBase64).toHaveBeenCalledTimes(2);
    expect(api.cacheImageFromBuffer).not.toHaveBeenCalled();
    expect(api.cacheMediaForSession).not.toHaveBeenCalled();
  });

  it('abort mode cleans up files it already created when a later persist step fails', async () => {
    api.cacheImageFromBuffer
      .mockResolvedValueOnce({ url: 'cindy-media://blobs/burned-a.png', filename: 'a.png' })
      .mockRejectedValueOnce(new Error('disk full'));
    const files = [
      imageFile({ id: 'a', annotationStrokes: strokes }),
      imageFile({ id: 'b', annotationStrokes: strokes }),
    ];

    await expect(
      materializeAnnotatedAttachmentsForSend(files, 's1', { burnFailure: 'abort' }),
    ).rejects.toBeInstanceOf(AnnotationBurnInError);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.cleanupCachedImages).toHaveBeenCalledWith(['cindy-media://blobs/burned-a.png']);
  });

  it('abort mode succeeds like fallback mode when every image burns', async () => {
    const result =
      (await materializeAnnotatedAttachmentsForSend(
        [
          imageFile({ id: 'a', annotationStrokes: strokes }),
          imageFile({ id: 'shared', url: 'cindy-media://blobs/history.png', cacheUrlShared: true }),
        ],
        's1',
        { burnFailure: 'abort' },
      )) ?? [];
    expect(result[0]).toMatchObject({ annotated: true, url: 'cindy-media://blobs/burned.png' });
    expect(result[1]).toMatchObject({ url: 'cindy-media://blobs/private.png' });
    expect(api.cleanupCachedImages).not.toHaveBeenCalled();
  });

  it('privatizes a shared history image whose strokes were all removed', async () => {
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [imageFile({ url: 'cindy-media://blobs/history.png', cacheUrlShared: true })],
        's1',
      )) ?? [];
    expect(api.cacheMediaForSession).toHaveBeenCalledWith({
      url: 'cindy-media://blobs/history.png',
      sessionId: 's1',
    });
    expect(result).toMatchObject({ url: 'cindy-media://blobs/private.png', size: 99 });
    expect(result.cacheUrlShared).toBeUndefined();
  });

  it('privatizes the unannotated fallback of a shared history image', async () => {
    api.readCachedImageAsBase64.mockRejectedValue(new Error('decode failed'));
    const onFallback = vi.fn();
    const [result] =
      (await materializeAnnotatedAttachmentsForSend(
        [
          imageFile({
            url: 'cindy-media://blobs/history.png',
            cacheUrlShared: true,
            annotationStrokes: strokes,
          }),
        ],
        's1',
        { onFallback },
      )) ?? [];
    expect(onFallback).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ url: 'cindy-media://blobs/private.png' });
    expect(result.cacheUrlShared).toBeUndefined();
    expect(result.annotated).toBeUndefined();
  });
});

describe('annotatedFileName', () => {
  it('keeps the user base name and never stacks the suffix', () => {
    expect(annotatedFileName('截图.png', '.png', 1)).toBe('截图-annotated.png');
    expect(annotatedFileName('photo.jpeg', '.jpg', 1)).toBe('photo-annotated.jpg');
    expect(annotatedFileName('photo-annotated.png', '.png', 1)).toBe('photo-annotated.png');
    expect(annotatedFileName('C:\\\\shots\\\\a.webp', '.png', 1)).toBe('a-annotated.png');
  });

  it('falls back to the implementation name for synthetic or missing names', () => {
    expect(annotatedFileName('annotated-1753.png', '.png', 42)).toBe('annotated-42.png');
    expect(annotatedFileName(undefined, '.png', 42)).toBe('annotated-42.png');
    expect(annotatedFileName('.png', '.jpg', 42)).toBe('annotated-42.jpg');
  });
});
