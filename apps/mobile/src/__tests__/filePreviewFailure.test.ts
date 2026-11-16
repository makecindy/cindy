import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  filePreviewFailureKind,
  filePreviewFailureText,
} from '@/session/filePreviewFailure';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('filePreviewFailure', () => {
  // Regression (#5426): the preview page rendered the raw host error string, so a
  // missing source file surfaced as "[MEDIA_FETCH_FAILED] [MEDIA_SOURCE_MISSING] …"
  // instead of the same friendly copy the conversation body already used (#5327).
  it('replaces the raw source-missing code with the shared friendly copy', () => {
    const error = new Error('[MEDIA_FETCH_FAILED] [MEDIA_SOURCE_MISSING] Media source is missing on this Host');
    expect(filePreviewFailureKind(error)).toBe('sourceMissing');
    const text = filePreviewFailureText(error);
    expect(text).toBe(i18n.t('message.lightbox.sourceMissing'));
    expect(text).not.toContain('MEDIA_SOURCE_MISSING');
    expect(text).not.toContain('MEDIA_FETCH_FAILED');
  });

  it('recognizes the source-missing marker through the transport wrapper as well', () => {
    expect(filePreviewFailureKind(new Error('[MEDIA_SOURCE_MISSING] missing'))).toBe('sourceMissing');
    expect(filePreviewFailureKind({ code: 'MEDIA_SOURCE_MISSING' })).toBe('sourceMissing');
  });

  it('tells an offline computer apart from a missing file', () => {
    expect(filePreviewFailureKind(new Error('[NOT_CONNECTED] relay closed'))).toBe('deviceOffline');
    expect(filePreviewFailureText(new Error('[NOT_CONNECTED] relay closed')))
      .toBe(i18n.t('message.lightbox.deviceOffline'));
  });

  it('localizes other remote failures without leaking the internal code', () => {
    const text = filePreviewFailureText(new Error('[ACCESS_REVOKED] revoked'));
    expect(text).toBe(i18n.t('deviceLink.remoteError.accessRevoked'));
    expect(text).not.toContain('ACCESS_REVOKED');
  });

  it('keeps local copy untouched when the failure carries no remote code', () => {
    expect(filePreviewFailureKind('下载失败')).toBe('plain');
    expect(filePreviewFailureText('下载失败')).toBe('下载失败');
  });
});
