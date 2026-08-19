import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

describe('Pi package compatibility copy', () => {
  it.each([
    ['en', en, 'question cards', 'timer', 'task transcript'],
    ['zh-CN', zhCN, '选择卡', '定时', '任务消息流'],
    ['zh-TW', zhTW, '選擇卡', '計時', '任務訊息流'],
    ['ja', ja, '選択カード', 'タイマー', 'タスクのメッセージ履歴'],
    ['ko', ko, '선택 카드', '타이머', '작업 메시지 기록'],
  ])('%s describes the implemented dialog and notification bridges', (
    _locale,
    catalog,
    cardCopy,
    timedCopy,
    transcriptCopy,
  ) => {
    const issues = catalog.settings.piPackages.issues;
    expect(issues['interactive-dialogs']).toContain(cardCopy);
    expect(issues['interactive-dialogs']).toContain(timedCopy);
    expect(issues.notifications).toContain(transcriptCopy);
  });
});
