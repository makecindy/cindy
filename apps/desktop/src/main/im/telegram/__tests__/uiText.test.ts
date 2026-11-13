import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../../i18n.desktop';
import { telegramUiText, ui } from '../uiText';

afterEach(() => setMainLocale('en'));

describe('Telegram user-facing task naming', () => {
  beforeEach(() => setMainLocale('zh-CN'));

  it('describes /new as creating a visible task instead of clearing a chat context', () => {
    expect(ui.slash.new).toContain('新任务已创建');
    expect(ui.slash.new).toContain('任务列表');
    expect(ui.slash.new).not.toContain('新对话');
    expect(ui.slash.new).not.toContain('上下文清掉');

    expect(ui.slash.help).toContain('/new         创建新任务');
    expect(ui.slash.help).toContain('旧任务保留');
  });
});

describe('Telegram control copy follows the interface language', () => {
  it('reads the current locale at send time, not at import time', () => {
    setMainLocale('zh-CN');
    expect(ui.agent.stopIdle).toContain('落了个空');
    expect(telegramUiText.expiredCardNotice).toBe('卡片已过期');

    setMainLocale('en');
    expect(ui.agent.stopIdle).toBe(
      "🤷 Nothing is running right now, so `!stop` had nothing to stop. Call me again when there's something to halt.",
    );
    expect(telegramUiText.expiredCardNotice).toBe('This card has expired');
    expect(ui.cards.plan.btnApprove).toBe('✅ Go ahead');
  });

  it('fills placeholders and keeps code-side branching', () => {
    setMainLocale('en');
    expect(ui.slash.unknownCommand('/foo')).toMatch(/^I don't recognize the command `\/foo` 🤔\n/);
    expect(ui.cards.control.resolvedSessionPick('Fix login', 'web')).toContain('**Fix login** (web)');
    expect(ui.agent.queuedNotice(1)).not.toContain('#');
    expect(ui.agent.queuedNotice(3)).toContain('#3 in the queue');
    expect(ui.cards.model.resolved('Opus', null)).toBe('✅ Switched to Opus');
    expect(ui.cards.model.resolved('Opus', 'high')).toBe('✅ Switched to Opus (effort: high)');
    expect(ui.agent.unsupportedOnly([{ label: 'clip.mov' }] as never)).toContain('\n• clip.mov\n');
    expect(
      ui.agent.authMissing({
        providerLabel: null,
        providerId: null,
        missing: 'provider-key',
        agentKind: 'codex',
        model: 'gpt-5',
        attached: true,
      } as never),
    ).toBe(
      '⚠️ This Telegram chat uses the provider “current provider” (gpt-5), but no API key has been set up for this provider yet.\n' +
        'Fix the authentication in desktop under Settings → Providers, then just keep sending messages.',
    );
  });

  it('picks plural forms for the dropped queue count', () => {
    setMainLocale('en');
    expect(ui.agent.stopDone(0)).toMatch(/^⏹ Stopped the current run\. /);
    expect(ui.agent.stopDone(1)).toContain('removed the queued message too');
    expect(ui.agent.stopDone(3)).toContain('removed 3 queued messages too');

    setMainLocale('zh-CN');
    expect(ui.agent.stopDone(3)).toContain('排队中的 3 条消息也一并撤了');
  });
});
