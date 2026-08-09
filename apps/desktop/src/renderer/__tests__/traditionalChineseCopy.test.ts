import { describe, expect, it } from 'vitest';

import zhTW from '../i18n/locales/zh-TW/common.json';

describe('Desktop Traditional Chinese high-risk copy', () => {
  it('uses deletion language for the account deletion flow', () => {
    const copy = zhTW.accountDeletion;
    expect(copy.entryButton).toBe('刪除帳號');
    expect(copy.introTitle).toBe('刪除帳號？');
    expect(copy.confirmButton).toBe('確認刪除帳號');
    expect(copy.status.pendingTitle).toContain('等待刪除');
    expect(copy.status.processingTitle).toContain('正在刪除');
    expect(copy.status.completedTitle).toBe('帳號已刪除');
    expect(copy.status.pendingCopy).not.toContain('登出');
  });

  it('does not leak common Simplified Chinese copy into the Traditional catalog', () => {
    const catalog = JSON.stringify(zhTW);
    for (const forbidden of [
      '許可權',
      '賬',
      '文本',
      '發送',
      '郵箱',
      '群后',
      '隻影響',
      '粘貼',
      '搜索',
      '數組',
      '創建於',
      '高質量',
      '密鑰',
      '綁定',
      '托盤',
      '周限',
      ' 周前',
      '{{count}} 周',
    ]) {
      expect(catalog).not.toContain(forbidden);
    }
  });

  it('uses 通過 only for pass/fail semantics, not as a via-channel translation', () => {
    expect(zhTW.settings.remote.viaAuth).toContain('透過');
    expect(zhTW.accountDeletion.codeSent).toContain('透過');
    expect(zhTW.skillhub.scanResult.passedTitle).toContain('通過');
  });
});
