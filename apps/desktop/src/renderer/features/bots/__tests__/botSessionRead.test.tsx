// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { botId: 'bot-1', sessionId: 'session-1' } as Record<string, string | undefined>,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ botUnreadBoundaryAt }: { botUnreadBoundaryAt?: number | null }) => (
    <div data-testid="chat" data-unread-boundary={botUnreadBoundaryAt ?? ''} />
  ),
}));

import { BotSessionView } from '../BotSessionView';
import {
  getBotLastReadAt,
  markBotRead,
  resetBotReadStateForTests,
  setBotReadStateOwner,
} from '../botReadState';

let messageListeners: Array<(payload: unknown) => void> = [];

function installElectronApi(bot: unknown, listedBot: unknown = bot): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: vi.fn(async () => bot),
          list: vi.fn(async () => [listedBot]),
        },
        messages: {
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
}

const readyBot = {
  id: 'bot-1',
  name: 'PR steward',
  status: 'active',
  enabled: true,
  sessions: [{ id: 'session-1', kind: 'chat', role: 'canonical', status: 'active' }],
};

beforeEach(() => {
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  setBotReadStateOwner('owner-1');
  mocks.params = { botId: 'bot-1', sessionId: 'session-1' };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
  installElectronApi(readyBot);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetBotReadStateForTests();
});

describe('Bot conversation read position', () => {
  it('marks the conversation read as soon as the chat is mounted', async () => {
    render(<BotSessionView />);

    await waitFor(() => expect(getBotLastReadAt('bot-1')).toBe(10_000));
  });

  it('preserves the entry read position for the unread divider while marking the chat read', async () => {
    markBotRead('bot-1', 5_000);
    installElectronApi(readyBot, { ...readyBot, unreadCount: 2 });

    const view = render(<BotSessionView />);

    await waitFor(() => expect(view.getByTestId('chat').dataset.unreadBoundary).toBe('5000'));
    expect(getBotLastReadAt('bot-1')).toBe(10_000);
  });

  it('keeps advancing the read position while the user is watching the chat', async () => {
    render(<BotSessionView />);
    await waitFor(() => expect(messageListeners.length).toBe(1));

    vi.setSystemTime(20_000);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'session-1' });
    });
    expect(getBotLastReadAt('bot-1')).toBe(20_000);

    // A row belonging to another task must not mark this Bot read.
    vi.setSystemTime(30_000);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'other-session' });
    });
    expect(getBotLastReadAt('bot-1')).toBe(20_000);
  });

  it('does not mark anything read when the Bot task cannot be opened', async () => {
    installElectronApi({ ...readyBot, status: 'archived' });

    render(<BotSessionView />);

    await waitFor(() => expect(messageListeners.length).toBe(0));
    expect(getBotLastReadAt('bot-1')).toBeNull();
  });
});
