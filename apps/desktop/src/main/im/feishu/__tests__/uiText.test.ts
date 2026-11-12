import { afterEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../../i18n.desktop';
import { feishuText, ui } from '../uiText';

afterEach(() => setMainLocale('en'));

describe('Feishu control copy follows the interface language', () => {
  it('reads the current locale at send time, not at import time', () => {
    setMainLocale('zh-CN');
    expect(ui.slash.new).toBe('🌱 新存档已开 — 之前的对话清掉了，从头聊~');
    expect(ui.cards.control.btnExit).toBe('🚪 退出');

    setMainLocale('en');
    expect(ui.slash.new).toBe("🌱 Fresh start — I've cleared our previous conversation. Let's begin again!");
    expect(ui.cards.control.btnExit).toBe('🚪 Exit');
    expect(ui.cards.permission.btnAllowOnce).toBe('✅ Allow once');
    expect(ui.slash.help).toContain('/exctr       End remote control and return to our DM');
  });

  it('fills placeholders and keeps code-side branching', () => {
    setMainLocale('en');
    expect(ui.slash.unknownCommand('/foo')).toMatch(/^I don't recognize the `\/foo` command 🤔\n/);
    expect(ui.cards.control.resolvedSessionPick('Fix login', 'web')).toContain('**Fix login** (web)');
    expect(ui.agent.queuedNotice(1)).not.toContain('#');
    expect(ui.agent.queuedNotice(3)).toContain('#3 in the queue');
    expect(ui.cards.model.resolved('Opus', null)).toBe('✅ Switched to Opus');
    expect(ui.cards.model.resolved('Opus', 'high')).toBe('✅ Switched to Opus (effort: high)');
    expect(ui.agent.scheduledTaskHeader(null)).toBe('🤖 Automation');
    expect(ui.agent.scheduledTaskHeader('Daily')).toBe('🤖 Automation “Daily”');
    expect(ui.cards.control.sessionBusyPrompts[0]('Fix login')).toContain('**Fix login**');
    expect(ui.cards.control.newSessionWelcomePrompts[3]('web')).toContain('**web**');
  });

  it('pluralises the !stop receipt and keeps the zero-queued branch separate', () => {
    setMainLocale('en');
    expect(ui.agent.stopDone(0)).toMatch(/^⏹ Stopped the current run\. The session/);
    expect(ui.agent.stopDone(1)).toContain('dropped 1 queued message.');
    expect(ui.agent.stopDone(3)).toContain('dropped 3 queued messages.');

    setMainLocale('zh-CN');
    expect(ui.agent.stopDone(2)).toContain('排队中的 2 条消息也一并撤了');
  });

  it('builds the auth notice from per-branch keys', () => {
    setMainLocale('en');
    const message = ui.agent.authMissing({
      agentKind: 'codex',
      model: 'gpt-6',
      providerId: null,
      providerLabel: null,
      missing: null,
      attached: true,
    });
    expect(message).toBe(
      '⚠️ This conversation uses the provider “current provider” (gpt-6): you need to sign in with your codex credentials first.\n' +
        'Fix authentication in the desktop app under Settings → Providers, then just keep sending messages.',
    );

    setMainLocale('zh-CN');
    expect(
      ui.agent.authMissing({
        agentKind: 'claude-code',
        model: 'opus',
        providerId: 'cindy',
        providerLabel: 'Cindy AI',
        missing: 'gateway-key',
      }),
    ).toBe(
      '⚠️ 当前对话使用供应商「Cindy AI」（opus），需要先配置 Cindy AI Key。\n' +
        '修改“新对话配置”后直接继续发送消息即可；若当前对话单独选过模型，请发送 `/model` 重新选择。',
    );
  });

  it('lists unsupported attachments inside the localized sentence', () => {
    setMainLocale('en');
    const text = ui.agent.unsupportedOnly([{ label: 'voice.amr' } as never, { label: 'clip.mp4' } as never]);
    expect(text).toBe(
      "🙏 I can't take in this message:\n• voice.amr\n• clip.mp4\n\n" +
        'What I can handle: text, images (jpg/png/gif/webp), PDFs, and code or config text files.',
    );
  });

  it('feishuText reads the slice namespace directly', () => {
    setMainLocale('ja');
    expect(feishuText('notice.platformFeishu')).toBe('Feishu');
    setMainLocale('zh-TW');
    expect(feishuText('notice.platformFeishu')).toBe('飛書');
  });
});
