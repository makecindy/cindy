// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WechatBotSection } from '../WechatBotSection';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  authorize: vi.fn(),
  cancelAuthorization: vi.fn(),
  unbind: vi.fn(),
  chooseWorkingDirectory: vi.fn(),
  resetWorkingDirectory: vi.fn(),
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
    },
    isAuthorizing: false,
    isUnbinding: false,
    isUpdatingWorkingDir: false,
    authorize: mocks.authorize,
    cancelAuthorization: mocks.cancelAuthorization,
    unbind: mocks.unbind,
    chooseWorkingDirectory: mocks.chooseWorkingDirectory,
    resetWorkingDirectory: mocks.resetWorkingDirectory,
  }),
}));

vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => <div data-testid="defaults" />,
}));

vi.mock('../ImChannelSettingsCard', () => ({
  useImChannelSettingsSummary: () => [null, vi.fn()],
  ImChannelSettingsCard: ({
    title,
    status,
    children,
  }: {
    title: string;
    status: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {status}
      {children}
    </section>
  ),
}));

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
  });

  it('explains the external Tencent authorization flow before starting it', async () => {
    render(<WechatBotSection expanded onToggle={vi.fn()} />);

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
