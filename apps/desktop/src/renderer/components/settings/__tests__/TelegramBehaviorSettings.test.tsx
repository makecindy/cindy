// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelegramHookBehaviorState } from '../../../../shared/hookControlIpc';
import { toast } from '@/lib/toast';

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
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

import {
  TelegramBehaviorSettings,
  TelegramGroupActivationSettings,
  TelegramPersonaSettings,
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
  api.setTelegramBehavior.mockImplementation(async (_bindingId, patch) => ({
    behavior: { ...behavior, ...patch },
  }));
  api.listTelegramGroups.mockResolvedValue({
    groups: [{ chatId: '-1001', chatName: 'Ops', activation: 'mention' }],
  });
  api.setTelegramGroupActivation.mockResolvedValue({ behavior });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    hookControl: api,
    telegramBot: { listGroups: api.listTelegramGroups, setGroupActivation: api.setTelegramGroupActivation },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Unit: editing a real persona field and closing settings flushes its pending
// value. A rejected flush still has to reach the user's notification.
it('reports a refused Telegram persona autosave when settings close', async () => {
  const persona = { botName: 'Fixture bot', soul: 'Old note' };
  const save = vi.fn().mockRejectedValue(new Error('[PRECONDITION_FAILED] fixture refusal'));
  vi.stubGlobal('electronAPI', {
    telegramBot: { getPersona: vi.fn().mockResolvedValue(persona), setPersona: save },
  });
  const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
  const view = render(<TelegramPersonaSettings />);
  const editor = await screen.findByDisplayValue('Old note');
  fireEvent.change(editor, { target: { value: 'New note' } });
  await act(async () => view.unmount());

  expect(save).toHaveBeenCalledExactlyOnceWith({ ...persona, soul: 'New note' });
  expect(errorToast).toHaveBeenCalledExactlyOnceWith('ipcError.PRECONDITION_FAILED');
});

describe('official Telegram behavior settings', () => {
  it('从 hook-control 读取并写入 emoji / 引用设置', async () => {
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    await waitFor(() =>
      expect(api.setTelegramBehavior).toHaveBeenCalledWith('binding-1', {
        emojiReactions: 'expressive',
      }),
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
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
      }),
    );
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(1));

    first.resolve({ behavior: { ...behavior, emojiReactions: 'expressive' } });
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole('radio', {
            name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
          })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('组件卸载后尚未发送的官方群写入仍携带触发时的 bindingId', async () => {
    const first = deferred<{ behavior: typeof behavior }>();
    api.setTelegramBehavior
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        behavior: { ...behavior, emojiReactions: 'expressive', replyQuoteGroup: 'all' },
      });
    const view = render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
      }),
    );
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(1));
    view.unmount();

    first.resolve({ behavior: { ...behavior, emojiReactions: 'expressive' } });
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledTimes(2));
    expect(api.setTelegramBehavior.mock.calls[1]?.[0]).toBe('binding-1');
  });

  it('绑定切换后旧账号的保存回执不覆盖新账号状态', async () => {
    const oldSave = deferred<{ behavior: typeof behavior }>();
    const secondBehavior = {
      ...behavior,
      bindingId: 'binding-2',
      emojiReactions: 'off' as const,
    };
    api.getTelegramBehavior.mockImplementation(async (bindingId: string) => ({
      behavior: bindingId === 'binding-2' ? secondBehavior : behavior,
    }));
    api.setTelegramBehavior.mockImplementationOnce(() => oldSave.promise);
    const view = render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    await waitFor(() => expect(api.setTelegramBehavior).toHaveBeenCalledOnce());

    view.rerender(<TelegramBehaviorSettings source="official" bindingId="binding-2" />);
    await waitFor(() =>
      expect(
        screen
          .getByRole('radio', {
            name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.off',
          })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );

    oldSave.resolve({ behavior: { ...behavior, emojiReactions: 'expressive' } });
    await act(async () => oldSave.promise);
    expect(
      screen
        .getByRole('radio', {
          name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.off',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
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
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    fireEvent.click(
      screen.getByRole('radio', {
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
        .getByRole('radio', {
          name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen
        .getByRole('radio', {
          name: 'settings.remoteControl.hook.telegram.behavior.quoteOption.all',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('写入失败后恢复权威值并给出可重试提示', async () => {
    api.setTelegramBehavior.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.expressive',
      }),
    );
    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.save'),
    ).toBeTruthy();
    expect(api.getTelegramBehavior).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('radio', {
          name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('已有行为缓存时重试读取失败仍显示加载错误与重试入口', async () => {
    api.setTelegramBehavior.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    fireEvent.click(
      await screen.findByRole('radio', {
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
    render(<TelegramBehaviorSettings source="official" bindingId="binding-1" />);

    expect(
      await screen.findByText('settings.remoteControl.hook.telegram.behavior.error.load'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.remoteControl.hook.telegram.behavior.error.retry',
      }),
    );
    expect(
      await screen.findByRole('radio', {
        name: 'settings.remoteControl.hook.telegram.behavior.emojiOption.minimal',
      }),
    ).toBeTruthy();
    expect(api.getTelegramBehavior).toHaveBeenCalledTimes(2);
  });

});

describe('personal Telegram group settings', () => {
  it('自建机器人仍可按群开启全响应', async () => {
    render(<TelegramGroupActivationSettings />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.telegramBot.groups.mode.always',
      }),
    );
    await waitFor(() =>
      expect(api.setTelegramGroupActivation).toHaveBeenCalledWith({ chatId: '-1001', mode: 'always' }),
    );
    expect(api.listTelegramGroups).toHaveBeenCalledOnce();
  });

  it('群模式写入失败后回滚并保留重试入口', async () => {
    api.setTelegramGroupActivation.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramGroupActivationSettings />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.telegramBot.groups.mode.always',
      }),
    );
    expect(
      await screen.findByText('settings.telegramBot.groups.error.save'),
    ).toBeTruthy();
    expect(api.listTelegramGroups).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('radio', {
          name: 'settings.telegramBot.groups.mode.mention',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('已有群列表缓存时重试读取失败仍显示加载错误与重试入口', async () => {
    api.setTelegramGroupActivation.mockRejectedValueOnce(new Error('offline'));
    render(<TelegramGroupActivationSettings />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.telegramBot.groups.mode.always',
      }),
    );
    await screen.findByText('settings.telegramBot.groups.error.save');
    api.listTelegramGroups.mockRejectedValueOnce(new Error('still offline'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.telegramBot.groups.error.retry',
      }),
    );

    expect(
      await screen.findByText('settings.telegramBot.groups.error.load'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'settings.telegramBot.groups.error.retry',
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
    render(<TelegramGroupActivationSettings />);

    expect(await screen.findByText('Ops')).toBeTruthy();
    const alwaysButtons = screen.getAllByRole('radio', {
      name: 'settings.telegramBot.groups.mode.always',
    });
    fireEvent.click(alwaysButtons[0]);
    fireEvent.click(alwaysButtons[1]);
    await waitFor(() => expect(api.setTelegramGroupActivation).toHaveBeenCalledTimes(1));
    first.reject(new Error('first group write failed'));

    expect(
      await screen.findByText('settings.telegramBot.groups.error.save'),
    ).toBeTruthy();
    expect(api.setTelegramGroupActivation).toHaveBeenCalledTimes(2);
    expect(api.listTelegramGroups).toHaveBeenCalledTimes(2);
    const mentionButtons = screen.getAllByRole('radio', {
      name: 'settings.telegramBot.groups.mode.mention',
    });
    expect(mentionButtons[0].getAttribute('aria-checked')).toBe('true');
    expect(alwaysButtons[1].getAttribute('aria-checked')).toBe('true');
  });
});
