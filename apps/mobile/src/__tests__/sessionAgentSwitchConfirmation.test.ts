import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { i18n } from '@/i18n';
import { confirmMobileSessionAgentSwitch } from '@/session/sessionAgentSwitchConfirmation';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('confirmMobileSessionAgentSwitch', () => {
  it('skips repeated confirmation when a pending intent already exists', async () => {
    const showAlert = vi.fn();
    await expect(confirmMobileSessionAgentSwitch('codex', true, showAlert)).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('keeps the current Agent on cancel or dismiss', async () => {
    const cancel = vi.fn((_title, _message, buttons) => buttons?.[0]?.onPress?.());
    await expect(confirmMobileSessionAgentSwitch('codex', false, cancel)).resolves.toBe(false);

    const dismiss = vi.fn((_title, _message, _buttons, options) => options?.onDismiss?.());
    await expect(confirmMobileSessionAgentSwitch('claude-code', false, dismiss)).resolves.toBe(false);
  });

  it('enters the other Agent browser only after explicit confirmation', async () => {
    const showAlert = vi.fn((_title, _message, buttons) => buttons?.[1]?.onPress?.());
    await expect(confirmMobileSessionAgentSwitch('codex', false, showAlert)).resolves.toBe(true);
    expect(showAlert.mock.calls[0]?.[0]).toBe('切换到 Codex？');
    expect(showAlert.mock.calls[0]?.[1]).toContain('下一条消息发送时');
  });
});
