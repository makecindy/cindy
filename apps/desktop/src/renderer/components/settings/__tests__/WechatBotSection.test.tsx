// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WechatBotSection } from '../WechatBotSection';
import { SETTINGS_SEARCH_ENTRIES } from '../settingsSearchCatalog';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  authorize: vi.fn(),
  cancelAuthorization: vi.fn(),
  unbind: vi.fn(),
  chooseWorkingDirectory: vi.fn(),
  resetWorkingDirectory: vi.fn(),
  setCompanion: vi.fn(),
  companionBotId: undefined as string | undefined,
  state: {
    phase: 'disconnected',
    bound: false,
    queuedTasks: 0,
  } as WechatBotState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/hooks/useWechatBot', () => ({
  useWechatBot: () => ({
    state: mocks.state,
    channelSettings: {
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
      companionBotId: mocks.companionBotId,
    },
    isAuthorizing: false,
    isUnbinding: false,
    isUpdatingWorkingDir: false,
    authorize: mocks.authorize,
    cancelAuthorization: mocks.cancelAuthorization,
    unbind: mocks.unbind,
    chooseWorkingDirectory: mocks.chooseWorkingDirectory,
    resetWorkingDirectory: mocks.resetWorkingDirectory,
    setCompanion: mocks.setCompanion,
    isUpdatingCompanion: false,
  }),
}));

vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => <div data-testid="defaults" />,
}));

vi.mock('../ImChannelSettingsCard', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ImChannelSettingsCard')>(),
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));

const searchTarget = SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === 'imBot.wechat')!.targetId;

describe('WechatBotSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {
      phase: 'disconnected',
      bound: false,
      queuedTasks: 0,
    };
    mocks.confirm.mockResolvedValue(true);
    mocks.authorize.mockResolvedValue(true);
    mocks.unbind.mockResolvedValue(true);
    mocks.companionBotId = undefined;
    mocks.setCompanion.mockResolvedValue(true);
  });

  // The teammate entry must use the existing authorization and binding APIs, without
  // exposing independent model defaults or replacing another teammate's connection.
  it('adopts an already connected WeChat account without reauthorizing it', async () => {
    mocks.state = { phase: 'connected', bound: true, queuedTasks: 0 };
    render(<WechatBotSection expanded onToggle={vi.fn()} companion={{ id: 'bot-cindy', name: 'Cindy' }} />);
    expect(screen.queryByTestId('defaults')).toBeNull();
    expect(document.getElementById(`${searchTarget}-trigger`)).toBeNull();
    expect(screen.getByRole('region').getAttribute('id')).toBe('companion-im-wechat-panel');
    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.companion.useExisting' }));
    await waitFor(() => expect(mocks.setCompanion).toHaveBeenCalledWith('bot-cindy'));
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.unbind).not.toHaveBeenCalled();
  });

  it("for a teammate on another computer keeps assignment and unbind here but sends authorization to that computer", () => {
    mocks.state = { phase: 'connected', bound: true, queuedTasks: 0 };
    mocks.companionBotId = 'bot-cindy';
    const { rerender } = render(<WechatBotSection expanded onToggle={vi.fn()} companion={{ id: 'bot-cindy', name: 'Cindy' }}
      host={{ name: 'Studio', api: {} as never }} />);
    // Re-binding opens a browser on the computer that runs WeChat: not offered here.
    expect(screen.queryByRole('button', { name: 'settings.wechatBot.actions.rebind' })).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.wechatBot.actions.unbind' })).toBeTruthy();
    mocks.state = { phase: 'disconnected', bound: false, queuedTasks: 0 };
    rerender(<WechatBotSection expanded onToggle={vi.fn()} companion={{ id: 'bot-cindy', name: 'Cindy' }}
      host={{ name: 'Studio', api: {} as never }} />);
    expect(screen.queryByRole('button', { name: 'settings.wechatBot.actions.connect' })).toBeNull();
    expect(screen.getByText('bots.remoteSettings.finishOnHost')).toBeTruthy();
  });

  it('does not expose authorization or unbind controls for another teammate', () => {
    mocks.state = { phase: 'connected', bound: true, queuedTasks: 0 };
    mocks.companionBotId = 'bot-other';
    render(<WechatBotSection expanded onToggle={vi.fn()} companion={{ id: 'bot-cindy', name: 'Cindy' }} />);
    expect(screen.getByText('settings.wechatBot.companion.other')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').getAttribute('aria-controls')).toBe('companion-im-wechat-panel');
  });

  it('does not open authorization if assigning the teammate fails', async () => {
    mocks.setCompanion.mockResolvedValue(false);
    render(<WechatBotSection expanded onToggle={vi.fn()} companion={{ id: 'bot-cindy', name: 'Cindy' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.actions.connect' }));
    await waitFor(() => expect(mocks.setCompanion).toHaveBeenCalledWith('bot-cindy'));
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  // CI #39297827964: verify the catalog's dynamic WeChat target in the real card DOM
  // (unit tier), rather than assuming every anchor is a literal JSX attribute.
  it('preserves the personal search target and explains authorization before starting it', async () => {
    const onToggle = vi.fn();
    render(<WechatBotSection expanded onToggle={onToggle} />);
    const trigger = document.getElementById(`${searchTarget}-trigger`);
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-controls')).toBe(`${searchTarget}-panel`);
    expect(document.getElementById(`${searchTarget}-panel`)?.getAttribute('role')).toBe('region');
    fireEvent.click(trigger!);
    expect(onToggle).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.actions.connect' }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'settings.wechatBot.authorization.title',
      confirmText: 'settings.wechatBot.authorization.confirm',
      autoFocusConfirm: true,
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
  });

  it('uses the replacement warning for an existing binding', async () => {
    mocks.state = {
      phase: 'connected',
      bound: true,
      queuedTasks: 0,
    };
    render(<WechatBotSection expanded onToggle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.actions.rebind' }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'settings.wechatBot.authorization.rebindTitle',
      description: 'settings.wechatBot.authorization.rebindDescription',
    });
  });

  it('allows an in-flight scan to be cancelled', () => {
    mocks.state = {
      phase: 'waiting_confirmation',
      bound: false,
      queuedTasks: 0,
    };
    render(<WechatBotSection expanded onToggle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.waiting.cancel' }));

    expect(mocks.cancelAuthorization).toHaveBeenCalledTimes(1);
  });

  it('confirms unbind while retaining existing Cindy history', async () => {
    mocks.state = {
      phase: 'needs_reauth',
      bound: true,
      queuedTasks: 0,
    };
    render(<WechatBotSection expanded onToggle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.wechatBot.actions.unbind' }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'settings.wechatBot.unbind.title',
      description: 'settings.wechatBot.unbind.description',
    });
    expect(mocks.unbind).toHaveBeenCalledTimes(1);
  });
});
