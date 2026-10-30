import { describe, expect, it } from 'vitest';

import { ui } from '../uiText';

describe('Telegram user-facing task naming', () => {
  it('describes /new as creating a visible task instead of clearing a chat context', () => {
    expect(ui.slash.new).toContain('新任务已创建');
    expect(ui.slash.new).toContain('任务列表');
    expect(ui.slash.new).not.toContain('新对话');
    expect(ui.slash.new).not.toContain('上下文清掉');

    expect(ui.slash.help).toContain('/new         创建新任务');
    expect(ui.slash.help).toContain('旧任务保留');
  });
});
