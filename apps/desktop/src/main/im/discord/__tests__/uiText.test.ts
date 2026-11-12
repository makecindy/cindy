/**
 * Discord 控制文案跟随主人界面语言：每次读取现取，切语言后下一条即生效。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../../i18n.desktop';
import { discordUiText, ui } from '../uiText';

describe('discord uiText locale', () => {
  afterEach(() => setMainLocale('en'));

  it('keeps the original Chinese copy under zh-CN', () => {
    setMainLocale('zh-CN');
    expect(ui.slash.new).toBe('🌱 新存档已开 — 之前的对话清掉了，从头聊~');
    expect(ui.slash.unknownCommand('/foo')).toBe(
      '没认出 `/foo` 这个命令 🤔\n我能听懂的：/new、/model、/permission、/ctr、/exctr、/help',
    );
    expect(ui.agent.stopDone(2)).toBe(
      '⏹ 已叫停当前执行，排队中的 2 条消息也一并撤了。任务还在——想继续随时发新指令~',
    );
    expect(discordUiText.expiredCardNotice).toBe('卡片已过期');
  });

  it('switches to English at read time and fills variables', () => {
    setMainLocale('zh-CN');
    expect(ui.cards.plan.title).toBe('📋 我打算这么干');

    setMainLocale('en');
    expect(ui.cards.plan.title).toBe('📋 Here’s my plan');
    expect(discordUiText.expiredCardNotice).toBe('This card has expired');
    expect(ui.cards.control.resolvedSessionPick('Fix login', 'web-app')).toBe(
      '🎯 You’re in: **Fix login** (web-app)\nYour messages now go straight to this session. Send `/exctr` anytime to leave.',
    );
    expect(ui.agent.queuedNotice(3)).toContain('#3 in the queue');
    expect(ui.agent.stopDone(1)).toContain('dropped the queued message too');
    expect(ui.agent.stopDone(4)).toContain('dropped the 4 queued messages too');
    expect(ui.agent.unsupportedOnly([{ label: 'Voice message' } as never])).toContain('\n• Voice message\n');
    expect(ui.cards.control.sessionBusyPrompts.map((prompt) => prompt('Build'))).toSatisfy(
      (lines: string[]) => lines.length === 4 && lines.every((line) => line.includes('**Build**') && !/[一-鿿]/.test(line)),
    );
  });

  it('builds the auth notice per missing credential in the current locale', () => {
    setMainLocale('en');
    const message = ui.agent.authMissing?.({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      providerLabel: null,
      missing: 'login',
      attached: false,
    });
    expect(message).toBe(
      '⚠️ This Discord conversation uses the provider “Current provider” (gpt-5.5), which requires signing in with codex credentials first.\n'
        + 'Update “New Conversation Configuration”, then just keep sending messages. If this conversation has its own model selected, send `/model` to choose again.',
    );
  });
});
