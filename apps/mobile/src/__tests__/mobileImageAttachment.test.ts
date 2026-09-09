import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { MOBILE_MAX_ATTACHMENT_BYTES } from '@/session/attachments';
import {
  assertMobileImageSize,
  buildMobileImageAttachmentCandidate,
  needsJpegConversion,
} from '@/session/mobileImageAttachment';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('mobileImageAttachment', () => {
  it('uses the picker filename, mime type, and size when available', () => {
    expect(buildMobileImageAttachmentCandidate({
      uri: 'file:///tmp/photo.png',
      fileName: 'camera.png',
      fileSize: 1234,
      mimeType: 'image/png',
    }, 0)).toEqual({
      uri: 'file:///tmp/photo.png',
      name: 'camera.png',
      size: 1234,
      mimeType: 'image/png',
    });
  });

  it('falls back to uri basename and inferred mime type', () => {
    expect(buildMobileImageAttachmentCandidate({
      uri: 'file:///tmp/library/photo.webp?cache=1',
      fileName: null,
      fileSize: null,
      mimeType: null,
    }, 0)).toEqual({
      uri: 'file:///tmp/library/photo.webp?cache=1',
      name: 'photo.webp',
      size: 0,
      mimeType: 'image/webp',
    });
  });

  it('generates a stable filename when native picker does not provide one', () => {
    expect(buildMobileImageAttachmentCandidate({
      uri: 'ph://asset-id-without-extension',
      mimeType: 'image/jpeg',
    }, 2)).toMatchObject({
      name: 'mobile-image-3.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('rejects missing uri and invalid sizes with user-facing errors', () => {
    expect(() => buildMobileImageAttachmentCandidate({ uri: '' }, 0)).toThrow('没有读取到可上传的图片');
    expect(() => assertMobileImageSize(0)).toThrow('图片为空');
    expect(() => assertMobileImageSize(MOBILE_MAX_ATTACHMENT_BYTES + 1)).toThrow('图片超过');
  });
});

describe('buildMobileImageAttachmentCandidate · HEIC / HEIF 归一(#3889)', () => {
  it('白名单格式(png / jpg / webp)不带 resolve 钩子,候选形状不变', () => {
    for (const [fileName, mimeType] of [['a.png', 'image/png'], ['b.JPG', null], ['c.webp', 'image/webp']] as const) {
      const candidate = buildMobileImageAttachmentCandidate({ uri: `file:///tmp/${fileName}`, fileName, mimeType }, 0);
      expect(candidate).not.toHaveProperty('resolve');
    }
  });

  it('文件名为 .heic / .HEIF 时带 resolve:预览仍用原始 uri,就位时转 JPEG 并改名', async () => {
    const convertToJpeg = vi.fn().mockResolvedValue('file:///tmp/converted.jpg');
    const candidate = buildMobileImageAttachmentCandidate({
      uri: 'file:///tmp/IMG_0001.HEIF',
      fileName: 'IMG_0001.HEIF',
      fileSize: 321,
      mimeType: null,
    }, 0, { convertToJpeg });
    // 入队当帧:原始 uri / 名字不动,托盘预览用得上。
    expect(candidate).toMatchObject({ uri: 'file:///tmp/IMG_0001.HEIF', name: 'IMG_0001.HEIF', size: 321 });
    expect(convertToJpeg).not.toHaveBeenCalled();
    await expect(candidate.resolve!()).resolves.toEqual({
      uri: 'file:///tmp/converted.jpg',
      name: 'IMG_0001.jpg',
      mimeType: 'image/jpeg',
      // 转码后 size 必须归 0:管线据此 stat 真实大小,否则沿用原 HEIC 字节数会撞大小校验。
      size: 0,
    });
    expect(convertToJpeg).toHaveBeenCalledWith('file:///tmp/IMG_0001.HEIF');
  });

  it('MIME 明示 image/heic 即使文件名扩展名像白名单也转 JPEG(MIME 为准)', async () => {
    const convertToJpeg = vi.fn().mockResolvedValue('file:///tmp/shot.jpg');
    const candidate = buildMobileImageAttachmentCandidate({
      uri: 'file:///tmp/screenshot.png',
      fileName: 'screenshot.png',
      mimeType: 'image/heic',
    }, 3, { convertToJpeg });
    await expect(candidate.resolve!()).resolves.toEqual({
      uri: 'file:///tmp/shot.jpg',
      name: 'screenshot.jpg',
      mimeType: 'image/jpeg',
      size: 0,
    });
  });

  it('未知扩展名(如 .tiff)同样归一;无扩展名但 MIME 为 jpeg 的 ph:// 资产不转', () => {
    expect(buildMobileImageAttachmentCandidate({ uri: 'file:///tmp/x.tiff', fileName: 'x.tiff', mimeType: 'image/tiff' }, 0))
      .toHaveProperty('resolve');
    expect(buildMobileImageAttachmentCandidate({ uri: 'ph://asset-no-ext', mimeType: 'image/jpeg' }, 0))
      .not.toHaveProperty('resolve');
  });

  it('needsJpegConversion 判定与粘贴链路口径一致', () => {
    expect(needsJpegConversion('a.heic', null)).toBe(true);
    expect(needsJpegConversion('a.jpg', 'image/heif')).toBe(true);
    expect(needsJpegConversion('a.jpg', 'image/jpeg')).toBe(false);
    expect(needsJpegConversion('a.GIF', undefined)).toBe(false);
  });
});
