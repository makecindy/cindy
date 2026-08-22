// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WecomBotSection } from '../WecomBotSection';

const mocks = vi.hoisted(() => ({
  chooseWorkingDirectory: vi.fn(),
  resetWorkingDirectory: vi.fn(),
  refreshChannelSettings: vi.fn(async () => undefined),
  channelSettings: {
    version: 1,
    workingDir: null,
    workingDirAvailable: true,
  } as WecomChannelSettingsState | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: () => <div data-testid="switch" />,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useWecomBot', () => ({
  useWecomBot: () => ({
    botId: '',
    setBotId: vi.fn(),
    secret: '',
    setSecret: vi.fn(),
    ownerUserId: '',
    status: { kind: 'idle' },
    channelSettings: mocks.channelSettings,
    validationError: null,
    isSaving: false,
    isDisconnecting: false,
    isUpdatingWorkingDir: false,
    canConnect: false,
    canReconnect: false,
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    chooseWorkingDirectory: mocks.chooseWorkingDirectory,
    resetWorkingDirectory: mocks.resetWorkingDirectory,
    refreshChannelSettings: mocks.refreshChannelSettings,
  }),
}));

vi.mock('@/hooks/useWecomGroupNotificationSettings', () => ({
  useWecomGroupNotificationSettings: () => ({
    configured: false,
    enabled: false,
    maskedKey: '',
    busy: false,
    setEnabled: vi.fn(async () => true),
    test: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    saveAndTest: vi.fn(async () => undefined),
  }),
}));

vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => <div data-testid="defaults" />,
}));

vi.mock('../ImChannelSettingsCard', () => ({
  useImChannelSettingsSummary: () => [null, vi.fn()],
  ImChannelSettingsCard: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

describe('WecomBotSection working directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channelSettings = { version: 1, workingDir: null, workingDirAvailable: true };
  });

  it('shows the managed-directory placeholder and no reset button by default', () => {
    render(<WecomBotSection expanded onToggle={vi.fn()} />);

    expect(screen.getByText('settings.wecomBot.workingDir.title')).toBeTruthy();
    expect(screen.getByText('settings.wecomBot.workingDir.managed')).toBeTruthy();
    // 无障碍名称说明动作而不是只有路径(t 为 identity mock, 返回 key 本身)。
    expect(
      screen.getByRole('button', { name: 'settings.wecomBot.workingDir.chooseAria' }),
    ).toBeTruthy();
    expect(screen.queryByText('settings.wecomBot.workingDir.reset')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('triggers the native picker and reset through the hook actions', () => {
    mocks.channelSettings = {
      version: 1,
      workingDir: 'D:/projects/wecom',
      workingDirAvailable: true,
    };
    render(<WecomBotSection expanded onToggle={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.wecomBot.workingDir.chooseAriaWithDir' }),
    );
    expect(mocks.chooseWorkingDirectory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'settings.wecomBot.workingDir.reset' }));
    expect(mocks.resetWorkingDirectory).toHaveBeenCalledTimes(1);
  });

  it('warns when the configured directory is unavailable', () => {
    mocks.channelSettings = {
      version: 1,
      workingDir: 'D:/gone',
      workingDirAvailable: false,
    };
    render(<WecomBotSection expanded onToggle={vi.fn()} />);

    expect(screen.getByRole('alert').textContent).toBe('settings.wecomBot.workingDir.unavailable');
  });

  it('refreshes channel settings when the card expands again', () => {
    const { rerender } = render(<WecomBotSection expanded={false} onToggle={vi.fn()} />);
    expect(mocks.refreshChannelSettings).not.toHaveBeenCalled();

    rerender(<WecomBotSection expanded onToggle={vi.fn()} />);
    expect(mocks.refreshChannelSettings).toHaveBeenCalledTimes(1);
  });

  it('refreshes channel settings when the window regains focus', () => {
    render(<WecomBotSection expanded onToggle={vi.fn()} />);
    expect(mocks.refreshChannelSettings).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(mocks.refreshChannelSettings).toHaveBeenCalledTimes(1);
  });
});
