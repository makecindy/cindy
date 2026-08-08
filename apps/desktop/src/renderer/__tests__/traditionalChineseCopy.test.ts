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
});
