import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { i18n } from '@/i18n';
import {
  confirmAgentLocationForPick,
  confirmMobileSessionAgentSwitch,
} from '@/session/sessionAgentSwitchConfirmation';

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

describe('confirmAgentLocationForPick (remote Agent)', () => {
  const base = {
    movable: true,
    session: { agentDeviceId: null },
    intent: null,
    deviceName: (deviceId: string) => (deviceId === 'device-studio-mac' ? '工作室 Mac' : deviceId),
    hostName: '家里的 Mac',
  };
  const confirm = () => vi.fn((_title, _message, buttons) => buttons?.[1]?.onPress?.());

  it('switches directly inside the same computer without asking', async () => {
    const showAlert = vi.fn();
    await expect(confirmAgentLocationForPick({ ...base, catalogDeviceId: null }, showAlert)).resolves.toEqual({});
    await expect(confirmAgentLocationForPick({
      ...base, session: { agentDeviceId: 'device-studio-mac' }, catalogDeviceId: 'device-studio-mac',
    }, showAlert)).resolves.toEqual({});
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('asks before moving to another computer, naming it', async () => {
    const showAlert = confirm();
    await expect(confirmAgentLocationForPick({ ...base, catalogDeviceId: 'device-studio-mac' }, showAlert))
      .resolves.toEqual({ agentDeviceId: 'device-studio-mac' });
    expect(showAlert.mock.calls[0]?.[0]).toBe('改到「工作室 Mac」上运行 Agent？');
    expect(showAlert.mock.calls[0]?.[1]).toContain('交接摘要');
    expect(showAlert.mock.calls[0]?.[2]?.map((button: { text: string }) => button.text))
      .toEqual(['保持不变', '换电脑运行']);
  });

  it('asks before moving back to the controlled computer', async () => {
    const named = confirm();
    await expect(confirmAgentLocationForPick({
      ...base, session: { agentDeviceId: 'device-studio-mac' }, catalogDeviceId: null,
    }, named)).resolves.toEqual({ agentDeviceId: null });
    expect(named.mock.calls[0]?.[0]).toBe('改回「家里的 Mac」上运行 Agent？');
    const unnamed = confirm();
    await confirmAgentLocationForPick({
      ...base, hostName: null, session: { agentDeviceId: 'device-studio-mac' }, catalogDeviceId: null,
    }, unnamed);
    expect(unnamed.mock.calls[0]?.[0]).toBe('改回任务所在的电脑运行 Agent？');
  });

  it('changes nothing when the move is cancelled or dismissed', async () => {
    const cancel = vi.fn((_title, _message, buttons) => buttons?.[0]?.onPress?.());
    await expect(confirmAgentLocationForPick({ ...base, catalogDeviceId: 'device-studio-mac' }, cancel))
      .resolves.toBeNull();
    const dismiss = vi.fn((_title, _message, _buttons, options) => options?.onDismiss?.());
    await expect(confirmAgentLocationForPick({ ...base, catalogDeviceId: 'device-studio-mac' }, dismiss))
      .resolves.toBeNull();
  });

  it('does not ask again for an already confirmed target', async () => {
    const showAlert = vi.fn();
    await expect(confirmAgentLocationForPick({
      ...base,
      intent: { targetAgentKind: 'codex', model: 'm', providerId: null, agentDeviceId: 'device-studio-mac' },
      catalogDeviceId: 'device-studio-mac',
    }, showAlert)).resolves.toEqual({ agentDeviceId: 'device-studio-mac' });
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('only accepts the controlled computer when the task cannot move', async () => {
    const showAlert = vi.fn();
    await expect(confirmAgentLocationForPick({ ...base, movable: false, catalogDeviceId: null }, showAlert))
      .resolves.toEqual({});
    await expect(confirmAgentLocationForPick({
      ...base, movable: false, catalogDeviceId: 'device-studio-mac',
    }, showAlert)).resolves.toBeNull();
    expect(showAlert).not.toHaveBeenCalled();
  });
});
