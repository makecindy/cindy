import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

describe('fixed cache directory cleanup copy', () => {
  it.each([
    ['en', en, 'Clear image cache', 'Clear attachment cache'],
    ['ja', ja, '画像キャッシュを削除', '添付ファイルキャッシュを削除'],
    ['ko', ko, '이미지 캐시 정리', '첨부 파일 캐시 정리'],
    ['zh-CN', zhCN, '清理图片缓存', '清理附件缓存'],
    ['zh-TW', zhTW, '清理圖片快取', '清理附件快取'],
  ] as const)(
    '%s names the target in settings and native confirmation actions',
    (_locale, messages, imageAction, attachmentAction) => {
      const storage = messages.settings.about.storage;

      expect(storage.legacyImagesClearButton).toBe(imageAction);
      expect(storage.legacyImagesClearConfirmButton).toBe(imageAction);
      expect(storage.chatAttachmentsClearButton).toBe(attachmentAction);
      expect(storage.chatAttachmentsClearConfirmButton).toBe(attachmentAction);
    },
  );
});
