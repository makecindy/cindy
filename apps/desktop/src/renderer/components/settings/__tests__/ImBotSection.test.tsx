// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImBotSection } from '../ImBotSection';
import { SettingsSearchNavigationContext } from '../SettingsSearchNavigation';
import imBotSearch from '../ImBotSection.settings-search';

const authState = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  membershipKind: 'org' as 'personal' | 'org' | null,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: authState.mode,
    dataOwnerId: 'owner-1',
    user: { membershipKind: authState.membershipKind },
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../HookConnectionsSection', () => ({
  HookConnectionsSection: () => <div data-testid="official-connections" />,
}));
vi.mock('../WechatBotSection', () => ({
  WechatBotSection: () => <div data-testid="wechat-bot" />,
}));
vi.mock('../WecomBotSection', () => ({
  WecomBotSection: () => <div data-testid="wecom-bot" />,
}));
vi.mock('@/hooks/useFeishuBot', async () => {
  const { useState } = await import('react');
  return {
    useFeishuBot: () => {
      const [service, setService] = useState<'feishu' | 'lark'>('feishu');
      return {
        service,
        setService,
        appId: '',
        setAppId: vi.fn(),
        appSecret: '',
        setAppSecret: vi.fn(),
        status: 'idle',
        errorMessage: null,
        hasSavedCreds: false,
        hasLoadedState: true,
        ownerOpenId: null,
        validationError: null,
        isSaving: false,
        isClearing: false,
        isReconnecting: false,
        save: vi.fn(),
        reconnect: vi.fn(),
        clear: vi.fn(),
      };
    },
  };
});
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImChannelSettingsCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ImChannelSettingsCard')>()),
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));
vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => null,
}));
vi.mock('../DingTalkBotSection', () => ({
  DingTalkBotSection: () => <div data-testid="dingtalk-bot" />,
}));
vi.mock('../DiscordBotSection', () => ({
  DiscordBotSection: () => <div data-testid="discord-bot" />,
}));
vi.mock('../TelegramBotSection', () => ({
  TelegramBotSection: () => <div data-testid="telegram-bot" />,
}));

describe('ImBotSection', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    authState.mode = 'cloud';
    authState.membershipKind = 'org';
    scrollIntoView.mockReset();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  it('shows official and personal bot types together in vertical sections', () => {
    render(<ImBotSection targetGroup={null} />);

    const official = screen.getByRole('heading', { name: 'settings.imBot.groups.cindy' });
    const personal = screen.getByRole('heading', { name: 'settings.imBot.groups.personal' });

    expect(official.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId('official-connections')).toBeTruthy();
    expect(screen.getByTestId('wechat-bot')).toBeTruthy();
    expect(screen.getByTestId('wecom-bot')).toBeTruthy();
    expect(screen.getByRole('button', { name: /settings.feishuBot.title/ })).toBeTruthy();
    expect(screen.getByTestId('dingtalk-bot')).toBeTruthy();
    expect(screen.getByTestId('discord-bot')).toBeTruthy();
    expect(screen.getByTestId('telegram-bot')).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('shows official, Discord, and Telegram bots to personal cloud accounts', () => {
    authState.membershipKind = 'personal';

    render(<ImBotSection targetGroup="cindy" />);

    expect(screen.getByTestId('official-connections')).toBeTruthy();
    expect(screen.getByTestId('discord-bot')).toBeTruthy();
    expect(screen.getByTestId('telegram-bot')).toBeTruthy();
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.cindy' }).closest('section'),
    );
  });

  it('shows and selects Lark for a personal cloud account opened from Lark search', () => {
    authState.membershipKind = 'personal';
    const entry = imBotSearch.entries.find((item) => item.id === 'imBot.lark')!;

    render(
      <SettingsSearchNavigationContext.Provider value={{ entry, activation: 1 }}>
        <ImBotSection targetGroup="personal" />
      </SettingsSearchNavigationContext.Provider>,
    );

    expect(
      screen
        .getByRole('radio', { name: 'settings.feishuBot.services.lark' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'settings.feishuBot.services.feishu' }));
    expect(
      screen
        .getByRole('radio', { name: 'settings.feishuBot.services.feishu' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps imGroup deep links by scrolling to the requested section', () => {
    render(<ImBotSection targetGroup="personal" />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' });
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.personal' }).closest('section'),
    );
  });

  it('shows only the personal section when the official group is unavailable', () => {
    authState.mode = 'local';
    authState.membershipKind = null;

    render(<ImBotSection targetGroup="cindy" />);

    expect(screen.queryByRole('heading', { name: 'settings.imBot.groups.cindy' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'settings.imBot.groups.personal' })).toBeTruthy();
    expect(screen.getByText('settings.imBot.tips.personal')).toBeTruthy();
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.personal' }).closest('section'),
    );
  });
});
