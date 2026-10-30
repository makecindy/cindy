// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IM_DEFAULT_SETTINGS, type ImDefaultSettingsState } from '../../../../shared/imDefaultSettings';
import { ImDefaultSettingsSection } from '../ImDefaultSettingsSection';

const capabilityMockState = vi.hoisted(() => ({
  providers: [] as ProviderView[],
  providersLoading: false,
  loadingAgent: null as string | null,
  errorAgent: null as string | null,
  piTurnPermissionPolicy: null as {
    supported: { supported: true };
    unsupportedPermissionModes: string[];
  } | null,
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/hooks/useAgentCapabilities', () => {
  // Pi 未声明 turnPermissionPolicy(警告);Claude Code / Codex 声明且受支持(不警告)。
  const supported = {
    capabilities: {
      availableModels: [],
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: [],
      },
    },
    loading: false,
    error: null,
  };
  return {
    useAgentCapabilities: (agentKind: string) => {
      if (capabilityMockState.loadingAgent === agentKind) {
        return { capabilities: null, loading: true, error: null };
      }
      if (capabilityMockState.errorAgent === agentKind) {
        return { capabilities: null, loading: false, error: 'capabilities unavailable' };
      }
      return agentKind === 'pi'
        ? {
            capabilities: {
              availableModels: [],
              ...(capabilityMockState.piTurnPermissionPolicy
                ? { turnPermissionPolicy: capabilityMockState.piTurnPermissionPolicy }
                : {}),
            },
            loading: false,
            error: null,
          }
        : supported;
    },
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: capabilityMockState.providers, loading: capabilityMockState.providersLoading }),
}));

vi.mock('@/hooks/useAvailableAgents', () => ({
  useModelPickerAgents: () => ['claude-code', 'codex', 'pi'],
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ onUnifiedSelect, fastModeConfigurable }: {
    onUnifiedSelect: (selection: object) => void; fastModeConfigurable: boolean;
  }) => <>
    <button data-testid="select-codex" data-fast-configurable={String(fastModeConfigurable)}
      onClick={() => onUnifiedSelect({ engine: 'codex', modelId: 'gpt-5.5', providerId: 'xd', effort: 'low', fast: false })}>Select Codex</button>
    <button data-testid="select-shared" onClick={() => onUnifiedSelect({ engine: 'codex', modelId: 'owner-model', providerId: 'owner-provider', effort: 'high', agentDevice: { deviceId: 'share:owner', name: 'Owner' } })}>Select shared</button>
  </>,
}));

vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: () => null,
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
    groupPermissionMode: 'auto',
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
  // PR #7291 unit: real settings component gets a catalog after its initial empty
  // read, then a late refresh races a manual save. Previously the display never refreshed.
  it('refreshes automatic models after catalog loading and protects a newer manual selection', async () => {
    const summary = vi.fn();
    const automatic = { ...defaults('codex'), automaticModel: true };
    automatic.agents.codex.model = '';
    capabilityMockState.providersLoading = true;
    let displayed = automatic;
    let pendingRead: Promise<ImDefaultSettingsState> | null = null;
    const get = vi.fn(() => pendingRead ?? Promise.resolve(displayed));
    window.electronAPI.maker.imDefaultSettingsGet = get;
    const saved = { ...defaults('codex'), automaticModel: false };
    saved.agents.codex.model = 'gpt-5.5';
    window.electronAPI.maker.imDefaultSettingsSet = vi.fn(async () => saved);
    const view = render(<ImDefaultSettingsSection channel="feishu" onSummaryChange={summary} />);
    await screen.findByText('settings.imBot.defaults.automaticUnavailable');
    displayed = { ...automatic, agents: { ...automatic.agents,
      codex: { ...automatic.agents.codex, model: 'new-recommendation' },
    } };
    capabilityMockState.providersLoading = false;
    capabilityMockState.providers = [];
    view.rerender(<ImDefaultSettingsSection channel="feishu" onSummaryChange={summary} />);
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith({ agentKind: 'codex', model: 'new-recommendation' }));
    let finishRead!: (state: ImDefaultSettingsState) => void;
    pendingRead = new Promise((resolve) => { finishRead = resolve; });
    const priorReads = get.mock.calls.length;
    capabilityMockState.providers = [];
    view.rerender(<ImDefaultSettingsSection channel="feishu" onSummaryChange={summary} />);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(priorReads));
    fireEvent.click(screen.getByTestId('select-codex'));
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith({ agentKind: 'codex', model: 'gpt-5.5' }));
    await act(async () => { finishRead(displayed); });
    expect(summary).toHaveBeenLastCalledWith({ agentKind: 'codex', model: 'gpt-5.5' });
    expect(screen.queryByText('settings.imBot.defaults.automatic')).toBeNull();
  });
  it('restores automatic selection without saving the displayed model or resetting permissions', async () => {
    const automatic = { ...defaults('codex'), automaticModel: true };
    const save = vi.fn(async (_patch: unknown) => {
      window.electronAPI.maker.imDefaultSettingsGet = vi.fn(async () => automatic);
      return automatic;
    });
    window.electronAPI.maker.imDefaultSettingsSet = save;
    render(<ImDefaultSettingsSection channel="feishu" />);
    fireEvent.click(await screen.findByText('settings.imBot.defaults.useAutomatic'));
    await screen.findByText('settings.imBot.defaults.automatic');
    expect(save).toHaveBeenCalledWith({ agentKind: IM_DEFAULT_SETTINGS.agentKind, agents: IM_DEFAULT_SETTINGS.agents }, 'feishu');
    expect(screen.queryByText('settings.imBot.defaults.useAutomatic')).toBeNull();
    fireEvent.click(screen.getByTestId('select-codex'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ agentKind: 'codex', agents: { codex: { model: 'gpt-5.5' } } });
  });
  it('saves a shared model and its location together without local catalog membership', async () => {
    const save = vi.fn(async () => defaults('codex'));
    window.electronAPI.maker.imDefaultSettingsSet = save;
    render(<ImDefaultSettingsSection channel="feishu" />);
    fireEvent.click(await screen.findByTestId('select-shared'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ agentKind: 'codex', agents: {
      codex: { providerId: 'owner-provider', model: 'owner-model', effort: 'high', agentDeviceId: 'share:owner' },
    } }, 'feishu'));
  });
  it('saves the complete selection in one update while preserving permissions', async () => {
    const save = vi.fn(async (_patch: unknown) => defaults('codex'));
    window.electronAPI.maker.imDefaultSettingsSet = save;
    render(<ImDefaultSettingsSection />);
    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(screen.getByTestId('select-codex').getAttribute('data-fast-configurable')).toBe('false');
    fireEvent.click(screen.getByTestId('select-codex'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({ agentKind: 'codex', agents: {
      codex: { providerId: 'xd', model: 'gpt-5.5', effort: 'low', agentDeviceId: null },
    } });
  });

  beforeEach(() => {
    capabilityMockState.providers = [];
    capabilityMockState.providersLoading = false;
    capabilityMockState.loadingAgent = null;
    capabilityMockState.errorAgent = null;
    capabilityMockState.piTurnPermissionPolicy = null;
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

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
  });

  it('appends the permission-mode hint when the channel default mode is incompatible with the replacement agents', async () => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({ ...defaults('pi'), permissionMode: 'bypassPermissions' })),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelModeHint',
    );
  });

  it('omits the permission-mode hint for a compatible default mode', async () => {
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).not.toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelModeHint',
    );
  });

  it('does not warn for Pi ask/auto once its turn policy capability supports those modes', async () => {
    capabilityMockState.piTurnPermissionPolicy = {
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    };
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns to change permission mode when Pi supports turn policy but not Full Access', async () => {
    capabilityMockState.piTurnPermissionPolicy = {
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    };
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({
          ...defaults('pi'),
          permissionMode: 'bypassPermissions',
        })),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.permissionModeUnsupportedOnChannelHint',
    );
    expect(status.textContent).not.toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
  });

  it('does not warn for a supported agent on wechat', async () => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('claude-code')),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn while the selected Agent capabilities are loading', async () => {
    capabilityMockState.loadingAgent = 'pi';
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn when the selected Agent capabilities failed to load', async () => {
    capabilityMockState.errorAgent = 'pi';
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn for Pi on channels without turn policy (feishu)', async () => {
    render(<ImDefaultSettingsSection channel="feishu" />);

    await screen.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn for Pi on conditional-policy channels (telegram / dingtalk)', async () => {
    // Telegram / 钉钉仅在群聊(event.speaker 存在)挂 turnPermissionPolicy,
    // 主人私聊 Pi 可用;设置 UI 不区分群聊/私聊,不能整体警告。
    const first = render(<ImDefaultSettingsSection channel="telegram" />);
    await first.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
    cleanup();

    const second = render(<ImDefaultSettingsSection channel="dingtalk" />);
    await second.findByText('settings.imBot.defaults.modelLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('renders the group /ctr permission field on feishu, hidden on other channels', async () => {
    const feishu = render(<ImDefaultSettingsSection channel="feishu" />);
    await feishu.findByText('settings.imBot.defaults.groupPermissionLabel');
    expect(
      feishu.queryByText('settings.imBot.defaults.groupPermissionDescription'),
    ).not.toBeNull();
    cleanup();

    const wechat = render(<ImDefaultSettingsSection channel="wechat" />);
    await wechat.findByText('settings.imBot.defaults.modelLabel');
    expect(
      wechat.queryByText('settings.imBot.defaults.groupPermissionLabel'),
    ).toBeNull();
  });
});
