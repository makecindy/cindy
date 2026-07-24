import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { MOBILE_MAX_ATTACHMENT_BYTES } from '@/session/attachments';
import {
  assertMobileImageSize,
  buildMobileImageAttachmentCandidate,
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
