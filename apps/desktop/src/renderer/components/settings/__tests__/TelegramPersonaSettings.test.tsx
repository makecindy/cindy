// @vitest-environment jsdom
// 人格请求失败时这一节不能卡住：同步按钮显示失败后恢复可点，读取失败保持空白且不产生未处理的 rejection。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TelegramPersonaSettings } from '../TelegramBehaviorSettings';

const getPersona = vi.fn();
const setPersona = vi.fn();
Object.assign(window, { electronAPI: { telegramBot: { getPersona, setPersona } } });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getPersona.mockReset();
  setPersona.mockReset();
});

describe('TelegramPersonaSettings', () => {
  it('同步资料失败时提示失败，并在提示结束后可重试', async () => {
    getPersona.mockResolvedValue({ botName: 'Cindy', soul: '' });
    setPersona.mockRejectedValueOnce(new Error('[IPC_ERROR] unavailable'));
    render(<TelegramPersonaSettings />);
    const sync = await screen.findByRole('button', { name: 'settings.telegramBot.persona.sync.idle' });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(sync);
    });
    expect(screen.getByRole('button', { name: 'settings.telegramBot.persona.sync.failed' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    const retry = screen.getByRole('button', { name: 'settings.telegramBot.persona.sync.idle' });
    expect(retry.matches(':disabled')).toBe(false);
  });

  it('读取人格失败时保持空白，不产生未处理的 rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    getPersona.mockRejectedValue(new Error('[IPC_ERROR] unavailable'));
    const { container } = render(<TelegramPersonaSettings />);
    await waitFor(() => expect(getPersona).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(container.textContent).toBe('');
    expect(unhandled).not.toHaveBeenCalled();
  });
});
