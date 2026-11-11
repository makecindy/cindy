import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ui } from '../uiText';
import { setMainLocale } from '../../../i18n.desktop';

// 断言中文控制文案:显式锁定界面语言,结束后还原默认。
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

describe('DingTalk UI text pack', () => {
  it('derives the complete shared pack instead of the expired-card fragment', () => {
    expect(ui.slash.new).toBeTruthy();
    expect(ui.agent.completedNoText).toBeTruthy();
    expect(ui.cards.model.title).toBeTruthy();
    expect(ui.cards.control.title).toBeTruthy();
  });

  it('does not advertise slash commands that require rich cards', () => {
    expect(ui.slash.help).not.toContain('/model');
    expect(ui.slash.help).not.toContain('/permission');
    expect(ui.slash.help).not.toContain('/ctr');
    expect(ui.slash.help).not.toContain('/session');
    expect(ui.slash.interactiveCommandUnsupported?.('/model')).toContain('Cindy 桌面端');
  });

  it('relabels inherited Telegram copy for DingTalk', () => {
    expect(ui.slash.detachedBySlash).toContain('钉钉');
    expect(ui.slash.detachedBySlash).not.toContain('Telegram');
  });
});

describe('DingTalk UI text follows the interface language', () => {
  it('serves its own copy and the inherited pack in English, with variables filled', () => {
    setMainLocale('en');
    expect(ui.slash.interactiveCommandUnsupported?.('/model')).toBe(
      "DingTalk doesn't support interactive choices for /model yet. Change this setting in Cindy Desktop instead.",
    );
    expect(ui.slash.unknownCommand('/ctr')).toContain("I don't recognize the command `/ctr`");
    expect(ui.slash.help).toContain('/new   Start a new chat');
    const copy = ui.error?.permissionModeUnsupported;
    expect(typeof copy === 'function' ? copy('default') : copy).toContain('“Auto-review” in Cindy');
    expect(ui.slash.detachedBySlash).not.toContain('Telegram');
    expect(ui.slash.detachedBySlash).toContain('DingTalk');
  });

  it('is a lazy view: switching language after import changes the next read', () => {
    setMainLocale('en');
    const english = ui.slash.help;
    setMainLocale('zh-CN');
    expect(ui.slash.help).not.toBe(english);
    expect(ui.slash.help).toContain('/new   开个新对话');
  });
});
