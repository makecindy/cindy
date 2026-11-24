// @vitest-environment jsdom
/**
 * Personal Telegram settings card hook.
 *
 * Maintainer review on #11994: when a new binding's handshake only timed out, the card keeps
 * both typed values (the transport rolled the saved owner back, which used to blank the owner
 * field), says "connection timed out, try again", and the next connect retries the same input
 * to connected without re-entering anything.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useTelegramBot } from '../useTelegramBot';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const OWNER = '4242';
const timedOutStatus = { kind: 'error', reason: 'handshake timed out', code: 'network' } as TelegramBotTransportStatus;

describe('useTelegramBot', () => {
  it('keeps the typed binding after a timed-out save and connects with it on the next try', async () => {
    const setConfig = vi
      .fn()
      .mockResolvedValueOnce({
        status: timedOutStatus,
        saveErrorStatus: timedOutStatus,
        saveTimedOut: true,
        ownerUserId: null,
        botUsername: null,
      })
      .mockResolvedValueOnce({
        status: { kind: 'connected', appId: '123456' },
        ownerUserId: OWNER,
        botUsername: 'mia_bot',
      });
    Object.assign(window, {
      electronAPI: {
        telegramBot: {
          getStatus: vi.fn(async () => ({ status: { kind: 'idle' }, ownerUserId: null, botUsername: null })),
          setConfig,
          onStatusChange: vi.fn(() => () => undefined),
        },
      },
    });

    const { result } = renderHook(() => useTelegramBot());
    await waitFor(() => expect(window.electronAPI.telegramBot.getStatus).toHaveBeenCalled());
    act(() => {
      result.current.setToken(TOKEN);
      result.current.setOwnerUserId(OWNER);
    });

    let connected: boolean | undefined;
    await act(async () => {
      connected = await result.current.connect();
    });
    expect(connected).toBe(false);
    expect(result.current.saveTimedOut).toBe(true);
    expect(result.current.token).toBe(TOKEN);
    expect(result.current.ownerUserId).toBe(OWNER);
    expect(result.current.canConnect).toBe(true);
    expect(toast.error).toHaveBeenCalledWith('settings.telegramBot.connectTimedOut');

    await act(async () => {
      connected = await result.current.connect();
    });
    expect(connected).toBe(true);
    expect(setConfig.mock.calls).toEqual([
      [{ token: TOKEN, ownerUserId: OWNER }],
      [{ token: TOKEN, ownerUserId: OWNER }],
    ]);
    expect(result.current.saveTimedOut).toBe(false);
    expect(result.current.status).toEqual({ kind: 'connected', appId: '123456' });
  });
});
