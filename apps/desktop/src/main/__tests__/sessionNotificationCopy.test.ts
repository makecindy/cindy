import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en'],
    getLocale: () => 'en',
  },
}));

import { setMainLocale } from '../i18n';
import {
  getSessionExternalNotificationText,
  getSessionNotificationBody,
  getSessionNotificationUntitled,
} from '../sessionNotificationCopy';
import type { SupportedLocale } from '../../shared/locale';

const CASES: Array<{
  locale: SupportedLocale;
  title: string;
  untitled: string;
  done: string;
  error: string;
  needsReply: string;
  externalDone: string;
  externalError: string;
  externalNeedsReply: string;
}> = [
  {
    locale: 'zh-CN',
    title: '整理报告',
    untitled: '未命名任务',
    done: '已完成 ✓',
    error: '执行失败',
    needsReply: '需要你回复',
    externalDone: 'Cindy · 任务「整理报告」已完成 ✓',
    externalError: 'Cindy · 任务「整理报告」执行失败',
    externalNeedsReply: 'Cindy · 任务「整理报告」需要你回复',
  },
  {
    locale: 'zh-TW',
    title: '整理報告',
    untitled: '未命名任務',
    done: '已完成 ✓',
    error: '執行失敗',
    needsReply: '需要你回覆',
    externalDone: 'Cindy · 任務「整理報告」已完成 ✓',
    externalError: 'Cindy · 任務「整理報告」執行失敗',
    externalNeedsReply: 'Cindy · 任務「整理報告」需要你回覆',
  },
  {
    locale: 'en',
    title: 'Report',
    untitled: 'Untitled session',
    done: 'Completed ✓',
    error: 'Failed',
    needsReply: 'Reply needed',
    externalDone: 'Cindy · Session “Report” completed ✓',
    externalError: 'Cindy · Session “Report” failed',
    externalNeedsReply: 'Cindy · Session “Report” needs your reply',
  },
  {
    locale: 'ja',
    title: 'レポート',
    untitled: '無題のセッション',
    done: '完了しました ✓',
    error: '実行に失敗しました',
    needsReply: '返信が必要です',
    externalDone: 'Cindy · セッション「レポート」が完了しました ✓',
    externalError: 'Cindy · セッション「レポート」の実行に失敗しました',
    externalNeedsReply: 'Cindy · セッション「レポート」への返信が必要です',
  },
  {
    locale: 'ko',
    title: '보고서',
    untitled: '제목 없는 세션',
    done: '완료됨 ✓',
    error: '실행 실패',
    needsReply: '답변이 필요합니다',
    externalDone: 'Cindy · 세션 “보고서” 완료됨 ✓',
    externalError: 'Cindy · 세션 “보고서” 실행 실패',
    externalNeedsReply: 'Cindy · 세션 “보고서”에 답변이 필요합니다',
  },
];

describe('session notification copy', () => {
  it.each(CASES)('$locale 使用当前语言生成三种状态与外部通知', (entry) => {
    setMainLocale(entry.locale);

    expect(getSessionNotificationUntitled()).toBe(entry.untitled);
    expect(getSessionNotificationBody('done')).toBe(entry.done);
    expect(getSessionNotificationBody('error')).toBe(entry.error);
    expect(getSessionNotificationBody('needs-reply')).toBe(entry.needsReply);
    expect(getSessionExternalNotificationText(entry.title, 'done')).toBe(entry.externalDone);
    expect(getSessionExternalNotificationText(entry.title, 'error')).toBe(entry.externalError);
    expect(getSessionExternalNotificationText(entry.title, 'needs-reply')).toBe(
      entry.externalNeedsReply,
    );
  });

  it('运行时切换语言后下一条通知立即跟随', () => {
    setMainLocale('en');
    expect(getSessionNotificationBody('needs-reply')).toBe('Reply needed');
    setMainLocale('zh-TW');
    expect(getSessionNotificationBody('needs-reply')).toBe('需要你回覆');
  });

  it.each(['foo$&bar', 'foo$`bar', "foo$'bar", 'foo$$bar'])(
    '将包含 JavaScript replacement token 的标题 %s 原样插入三种外部通知',
    (title) => {
      setMainLocale('en');
      expect(getSessionExternalNotificationText(title, 'done')).toBe(
        `Cindy · Session “${title}” completed ✓`,
      );
      expect(getSessionExternalNotificationText(title, 'error')).toBe(
        `Cindy · Session “${title}” failed`,
      );
      expect(getSessionExternalNotificationText(title, 'needs-reply')).toBe(
        `Cindy · Session “${title}” needs your reply`,
      );
    },
  );
});
