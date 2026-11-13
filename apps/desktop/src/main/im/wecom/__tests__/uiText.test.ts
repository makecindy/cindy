import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ui } from '../uiText';
import { setMainLocale } from '../../../i18n.desktop';

// 断言中文控制文案:显式锁定界面语言,结束后还原默认。
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

describe('WeCom UI text', () => {
  it('uses 任务 for session-level actions and 对话 for the chat channel', () => {
    expect(ui.slash.new).toContain('新任务');
    expect(ui.slash.help).toContain('/new         开始新任务');
    expect(ui.slash.detachedBySlash).toContain('企业微信对话');
    expect(ui.cards.control.sessionPickerHint).toContain('选择任务、创建新任务');
    expect(ui.cards.control.newSessionWelcomePrompts[0]?.('工作区')).toContain('创建新任务');
  });
});

describe('WeCom UI text follows the interface language', () => {
  it('reads each leaf at send time, so a language switch applies to the next message', () => {
    setMainLocale('en');
    expect(ui.slash.new).toBe('🌱 New task started. The previous context has been cleared.');
    expect(ui.slash.unknownCommand('/model')).toBe(
      'Unknown command `/model`. Available commands: /new, /stop, /exctr, /help',
    );
    expect(ui.agent.queuedNotice(3)).toContain('#3 in the queue');
    expect(ui.agent.stopDone(1)).toBe('⏹ Stopped the current task and removed 1 queued message.');
    expect(ui.agent.stopDone(2)).toBe('⏹ Stopped the current task and removed 2 queued messages.');
    expect(
      ui.agent.authMissing?.({
        agentKind: 'claude-code',
        model: 'opus',
        providerId: null,
        providerLabel: 'Cindy AI',
        missing: 'gateway-key',
      }),
    ).toBe(
      '⚠️ This WeCom chat uses “Cindy AI” (opus): set up a Cindy AI Key first.\n' +
        'Update “New Conversation Configuration”, then just keep sending messages. If this chat has its own model selected, send `/new` to start a new task.',
    );
    setMainLocale('zh-CN');
    expect(ui.slash.new).toBe('🌱 新任务已开始，之前的上下文已清空。');
    expect(ui.agent.stopDone(2)).toBe('⏹ 已中止当前任务，并移除 2 条排队消息。');
  });
});
