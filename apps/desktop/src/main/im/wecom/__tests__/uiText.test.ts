import { describe, expect, it } from 'vitest';

import { ui } from '../uiText';

describe('WeCom UI text', () => {
  it('uses 任务 for session-level actions and 对话 for the chat channel', () => {
    expect(ui.slash.new).toContain('新任务');
    expect(ui.slash.help).toContain('/new         开始新任务');
    expect(ui.slash.detachedBySlash).toContain('企业微信对话');
    expect(ui.cards.control.sessionPickerHint).toContain('选择任务、创建新任务');
    expect(ui.cards.control.newSessionWelcomePrompts[0]?.('工作区')).toContain('创建新任务');
  });
});
