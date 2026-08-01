// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelegramHookBehaviorState } from '../../../../shared/hookControlIpc';

const api = vi.hoisted(() => ({
  getTelegramBehavior: vi.fn(),
  setTelegramBehavior: vi.fn(),
  listTelegramGroups: vi.fn(),
  setTelegramGroupActivation: vi.fn(),
  onTelegramBehaviorChanged: vi.fn<
    (listener: (behavior: TelegramHookBehaviorState) => void) => () => void
  >(() => () => {}),
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

const behavior: TelegramHookBehaviorState = {
  bindingId: 'binding-1',
  bound: true,
  emojiReactions: 'minimal' as const,
  replyQuoteDm: 'off' as const,
  replyQuoteGroup: 'first' as const,
  groupActivation: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
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

  it('串行写入快速连续修改，不让较早回执覆盖最新选择', async () => {
    const first = deferred<{ behavior: typeof behavior }>();
    api.setTelegramBehavior
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        behavior: { ...behavior, emojiReactions: 'expressive', replyQuoteGroup: 'all' },
      });
    render(<TelegramBehaviorSettings source="official" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
      }),
    );
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(1));

    first.resolve({ behavior: { ...behavior, emojiReactions: 'expressive' } });
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', {
            name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
          })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('队列中较早写入失败也会在排空后重读并提示', async () => {
    const first = deferred<{ behavior: typeof behavior }>();
    const authoritative = { ...behavior, replyQuoteGroup: 'all' as const };
    api.getTelegramBehavior
      .mockReset()
      .mockResolvedValueOnce({ behavior })
      .mockResolvedValueOnce({ behavior: authoritative });
    api.setTelegramBehavior
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ behavior: authoritative });
    render(<TelegramBehaviorSettings source="official" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
      }),
    );
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(1));
    first.reject(new Error('first write failed'));

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.save'),
    ).toBeTruthy();
    expect(api.setTelegramBehavior).toHaveBeenCalledTimes(2);
    expect(api.getTelegramBehavior).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('button', {
          name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
        })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', {
          name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
        })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('写入失败后恢复权威值并给出可重试提示', async () => {
    api.setTelegramBehavior.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramBehaviorSettings source="official" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.save'),
    ).toBeTruthy();
    expect(api.getTelegramBehavior).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('button', {
          name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
        })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('已有行为缓存时重试读取失败仍显示加载错误与重试入口', async () => {
    api.setTelegramBehavior.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramBehaviorSettings source="official" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.save');
    api.getTelegramBehavior.mockRejectedValueOnce(new Error('still offline'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.error.retry',
      }),
    );

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.load'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.error.retry',
      }),
    ).toBeTruthy();
  });

  it('首次读取失败后可主动重试', async () => {
    api.getTelegramBehavior
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ behavior });
    render(<TelegramBehaviorSettings source="official" />);

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.load'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.error.retry',
      }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
      }),
    ).toBeTruthy();
    expect(api.getTelegramBehavior).toHaveBeenCalledTimes(2);
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

  it('实时行为推送会补入本地群列表中尚不存在的 override', async () => {
    let behaviorChanged: ((next: TelegramHookBehaviorState) => void) | undefined;
    api.onTelegramBehaviorChanged.mockImplementationOnce((listener) => {
      behaviorChanged = listener;
      return () => {};
    });
    render(<TelegramGroupActivationSettings source="official" />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    act(() => {
      behaviorChanged?.({
        ...behavior,
        groupActivation: { '-1002': 'always' },
      });
    });

    expect(screen.getAllByText('-1002').length).toBeGreaterThan(0);
    const alwaysButtons = screen.getAllByRole('button', {
      name: 'settings.remoteControl.hook.telegram.groups.mode.always',
    });
    expect(alwaysButtons).toHaveLength(2);
    expect(alwaysButtons[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('群模式写入失败后回滚并保留重试入口', async () => {
    api.setTelegramGroupActivation.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramGroupActivationSettings source="official" />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.groups.mode.always',
      }),
    );
    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.groups.error.save'),
    ).toBeTruthy();
    expect(api.listTelegramGroups).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('button', {
          name: 'settings.remoteControl.hook.telegram.groups.mode.mention',
        })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('已有群列表缓存时重试读取失败仍显示加载错误与重试入口', async () => {
    api.setTelegramGroupActivation.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramGroupActivationSettings source="official" />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.groups.mode.always',
      }),
    );
    await screen.findByText('settings.remoteControl.hook.telegram.groups.error.save');
    api.listTelegramGroups.mockRejectedValueOnce(new Error('still offline'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.groups.error.retry',
      }),
    );

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.groups.error.load'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.groups.error.retry',
      }),
    ).toBeTruthy();
  });

  it('群模式队列中较早失败不会被后续成功静默吞掉', async () => {
    const first = deferred<{ behavior: typeof behavior }>();
    const initialGroups = [
      { chatId: '-1001', chatName: 'Ops', activation: 'mention' as const },
      { chatId: '-1002', chatName: 'Eng', activation: 'mention' as const },
    ];
    const authoritativeGroups = [
      initialGroups[0],
      { ...initialGroups[1], activation: 'always' as const },
    ];
    api.listTelegramGroups
      .mockReset()
      .mockResolvedValueOnce({ groups: initialGroups })
      .mockResolvedValueOnce({ groups: authoritativeGroups });
    api.setTelegramGroupActivation
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        behavior: { ...behavior, groupActivation: { '-1002': 'always' as const } },
      });
    render(<TelegramGroupActivationSettings source="official" />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    const alwaysButtons = screen.getAllByRole('button', {
      name: 'settings.remoteControl.hook.telegram.groups.mode.always',
    });
    fireEvent.click(alwaysButtons[0]);
    fireEvent.click(alwaysButtons[1]);
    await waitFor(() => expect(api.setTelegramGroupActivation).toHaveBeenCalledTimes(1));
    first.reject(new Error('first group write failed'));

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.groups.error.save'),
    ).toBeTruthy();
    expect(api.setTelegramGroupActivation).toHaveBeenCalledTimes(2);
    expect(api.listTelegramGroups).toHaveBeenCalledTimes(2);
    const mentionButtons = screen.getAllByRole('button', {
      name: 'settings.remoteControl.hook.telegram.groups.mode.mention',
    });
    expect(mentionButtons[0].getAttribute('aria-pressed')).toBe('true');
    expect(alwaysButtons[1].getAttribute('aria-pressed')).toBe('true');
  });
});
