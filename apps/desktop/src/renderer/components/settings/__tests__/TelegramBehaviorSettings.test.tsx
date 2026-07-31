// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getTelegramBehavior: vi.fn(),
  setTelegramBehavior: vi.fn(),
  listTelegramGroups: vi.fn(),
  setTelegramGroupActivation: vi.fn(),
  onTelegramBehaviorChanged: vi.fn(() => () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/contactsService', () => ({
  contactsService: {
    settingsGet: vi.fn(async () => ({ enabled: true })),
    settingsSet: vi.fn(),
  },
}));

import {
  TelegramBehaviorSettings,
  TelegramGroupActivationSettings,
} from '../TelegramBehaviorSettings';

const behavior = {
  bindingId: 'binding-1',
  bound: true,
  emojiReactions: 'minimal' as const,
  replyQuoteDm: 'off' as const,
  replyQuoteGroup: 'first' as const,
  groupActivation: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  api.onTelegramBehaviorChanged.mockReturnValue(() => {});
  api.getTelegramBehavior.mockResolvedValue({ behavior });
  api.setTelegramBehavior.mockImplementation(async (patch) => ({
    behavior: { ...behavior, ...patch },
  }));
  api.listTelegramGroups.mockResolvedValue({
    groups: [{ chatId: '-1001', chatName: 'Ops', activation: 'mention' }],
  });
  api.setTelegramGroupActivation.mockResolvedValue({ behavior });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    hookControl: api,
  };
});

afterEach(() => cleanup());

describe('official Telegram behavior settings', () => {
  it('从 hook-control 读取并写入 emoji / 引用设置', async () => {
    render(<TelegramBehaviorSettings source="official" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    await waitFor(() =>
      expect(api.setTelegramBehavior).toHaveBeenCalledWith({ emojiReactions: 'expressive' }),
    );
    expect(api.getTelegramBehavior).toHaveBeenCalledOnce();
    expect(api.onTelegramBehaviorChanged).toHaveBeenCalledOnce();
  });

  it('列出官方群并把参与模式写回服务端', async () => {
    render(<TelegramGroupActivationSettings source="official" />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.groups.mode.always',
      }),
    );
    await waitFor(() =>
      expect(api.setTelegramGroupActivation).toHaveBeenCalledWith('-1001', 'always'),
    );
    expect(api.listTelegramGroups).toHaveBeenCalledOnce();
  });
});
