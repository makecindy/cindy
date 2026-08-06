// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IM_DEFAULT_SETTINGS, type ImDefaultSettingsState } from '../../../../shared/imDefaultSettings';
import { ImDefaultSettingsSection } from '../ImDefaultSettingsSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: { availableModels: [] } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

vi.mock('@/components/new-chat/AgentSelect', () => ({
  AgentSelect: () => null,
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => null,
}));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: () => null,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function defaults(agentKind: ImDefaultSettingsState['agentKind']): ImDefaultSettingsState {
  return {
    agentKind,
    permissionMode: 'auto',
    agents: {
      'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
      codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
      pi: { providerId: null, model: 'claude-sonnet-5', effort: 'high' },
    },
    isCustomized: false,
    customizedKeys: [],
    defaults: IM_DEFAULT_SETTINGS,
  };
}

describe('ImDefaultSettingsSection Pi channel warning', () => {
  beforeEach(() => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('pi')),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('warns when Pi is selected on a turn-policy channel (wechat)', async () => {
    render(<ImDefaultSettingsSection channel="wechat" />);

    expect(
      await screen.findByText('settings.imBot.defaults.piUnsupportedHint'),
    ).toBeTruthy();
  });

  it('does not warn for a supported agent on wechat', async () => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('claude-code')),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(screen.queryByText('settings.imBot.defaults.piUnsupportedHint')).toBeNull();
  });

  it('does not warn for Pi on channels without turn policy (feishu)', async () => {
    render(<ImDefaultSettingsSection channel="feishu" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(screen.queryByText('settings.imBot.defaults.piUnsupportedHint')).toBeNull();
  });

  it('does not warn for Pi on conditional-policy channels (telegram / dingtalk)', async () => {
    // Telegram / 钉钉仅在群聊(event.speaker 存在)挂 turnPermissionPolicy,
    // 主人私聊 Pi 可用;设置 UI 不区分群聊/私聊,不能整体警告。
    const first = render(<ImDefaultSettingsSection channel="telegram" />);
    await first.findByText('settings.imBot.defaults.agentLabel');
    expect(screen.queryByText('settings.imBot.defaults.piUnsupportedHint')).toBeNull();
    cleanup();

    const second = render(<ImDefaultSettingsSection channel="dingtalk" />);
    await second.findByText('settings.imBot.defaults.agentLabel');
    expect(screen.queryByText('settings.imBot.defaults.piUnsupportedHint')).toBeNull();
  });
});
