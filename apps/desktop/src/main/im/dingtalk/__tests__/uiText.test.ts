import { describe, expect, it } from 'vitest';

import { ui } from '../uiText';

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
