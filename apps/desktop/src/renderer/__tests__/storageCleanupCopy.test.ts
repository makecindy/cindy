import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

describe('storage cleanup copy', () => {
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

  it.each([
    ['en', en, ['database backup', 'review or undo', 'cannot be restored']],
    ['ja', ja, ['データベースのバックアップ', 'レビューや元に戻す', '復元できません']],
    ['ko', ko, ['데이터베이스 백업', '검토하거나 실행 취소', '복구할 수 없습니다']],
    ['zh-CN', zhCN, ['数据库备份', '审查或撤销', '无法恢复']],
    ['zh-TW', zhTW, ['資料庫備份', '審查或撤銷', '無法復原']],
  ] as const)(
    '%s states that file-change review and undo records are excluded from the database backup',
    (_locale, messages, expectedFragments) => {
      const description =
        messages.settings.about.storage.dbSlimmingIncludeActiveConfirmDescription;

      for (const fragment of expectedFragments) expect(description).toContain(fragment);
    },
  );
});
